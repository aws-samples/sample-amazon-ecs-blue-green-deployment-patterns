import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'path';
import { EcsBluegreenNetworkingStack } from './ecs-bluegreen-networking-stack';
import { EcsBluegreenHookStack } from './ecs-bluegreen-hook-stack';
import { NagSuppressions } from "cdk-nag";

export interface EcsBluegreenEcsStackProps extends cdk.StackProps {
    networkingStack: EcsBluegreenNetworkingStack;
    hookStack: EcsBluegreenHookStack;
}

export class EcsBluegreenEcsStack extends cdk.Stack {
    public readonly ecsClusterName: string;
    public readonly ecsServiceName: string;

    constructor(scope: Construct, id: string, props: EcsBluegreenEcsStackProps) {
        super(scope, id, props);

        const vpc = props.networkingStack.vpc;
        const serviceName = 'sqs-worker';

        // CloudWatch Log Group for ECS task logs
        const ecsLogGroup = new logs.LogGroup(this, 'ECSLogGroup', {
            logGroupName: `/aws/ecs/service/${this.stackName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ECS Cluster
        const cluster = new ecs.Cluster(this, 'ECSCluster', {
            vpc,
            enableFargateCapacityProviders: true,
            containerInsightsV2: ecs.ContainerInsights.ENHANCED,
        });

        NagSuppressions.addResourceSuppressions(cluster, [{
            id: 'AwsSolutions-ECS4',
            reason: 'Container Insights Enhanced not yet supported in CDK Nag',
        }], true);

        // Task Execution Role — pull images, write logs
        const taskExecutionRole = new iam.Role(this, 'ECSTaskExecutionRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
            ],
            path: '/'
        });

        NagSuppressions.addResourceSuppressions(taskExecutionRole, [{
            id: 'AwsSolutions-IAM4',
            reason: 'AmazonECSTaskExecutionRolePolicy is the standard managed policy for ECS task execution roles',
            appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy']
        }, {
            id: 'AwsSolutions-IAM5',
            reason: 'ecr:GetAuthorizationToken requires Resource * and is added by CDK when using DockerImageAsset',
            appliesTo: ['Resource::*']
        }], true);

        // Task Role — SSM read, SQS consume, ECS self-discovery and task protection
        const taskRole = new iam.Role(this, 'ECSTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            path: '/'
        });

        taskRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter'],
            resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/myapp/sqs-processing-enabled/*`]
        }));

        taskRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
            resources: [props.hookStack.sqsQueue.queueArn]
        }));

        taskRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ecs:DescribeTasks', 'ecs:UpdateTaskProtection'],
            resources: [`arn:aws:ecs:${this.region}:${this.account}:task/${cluster.clusterName}/*`]
        }));

        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/ECSTaskRole/DefaultPolicy/Resource`,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'SSM parameter and ECS task ARNs use wildcards because deployment/task IDs are not known at deploy time',
            }],
            true
        );

        // Lambda Invoke Role — allows ECS to invoke lifecycle hook Lambdas
        const ecsLambdaInvokeRole = new iam.Role(this, 'ECSLambdaInvokeRole', {
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('ecs.amazonaws.com')
            ),
            path: '/'
        });

        ecsLambdaInvokeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['lambda:InvokeFunction'],
            resources: [props.hookStack.trafficShiftFunctionArn]
        }));

        // Worker Docker image
        const workerImage = new ecr_assets.DockerImageAsset(this, 'WorkerImage', {
            directory: path.join(__dirname, '../src/worker'),
            file: 'Dockerfile',
        });

        // Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
            family: 'sqs-worker',
            cpu: 256,
            memoryLimitMiB: 512,
            executionRole: taskExecutionRole,
            taskRole: taskRole,
        });

        taskDefinition.addContainer('sqs-worker', {
            image: ecs.ContainerImage.fromDockerImageAsset(workerImage),
            environment: {
                SQS_QUEUE_URL: props.hookStack.sqsQueue.queueUrl,
                ECS_CLUSTER_NAME: cluster.clusterName,
            },
            logging: ecs.LogDrivers.awsLogs({
                logGroup: ecsLogGroup,
                streamPrefix: 'sqs-worker',
            }),
        });

        NagSuppressions.addResourceSuppressions(taskDefinition, [{
            id: 'AwsSolutions-ECS2',
            reason: 'SQS_QUEUE_URL and ECS_CLUSTER_NAME are non-sensitive configuration values',
        }], true);

        // Suppress IAM5 on the execution role's DefaultPolicy (created by addContainer granting ECR pull)
        const execRoleDefaultPolicy = taskExecutionRole.node.tryFindChild('DefaultPolicy');
        if (execRoleDefaultPolicy) {
            NagSuppressions.addResourceSuppressions(execRoleDefaultPolicy, [{
                id: 'AwsSolutions-IAM5',
                reason: 'ecr:GetAuthorizationToken requires Resource * and is added by CDK for DockerImageAsset',
                appliesTo: ['Resource::*']
            }], true);
        }

        // ECS Service with native blue/green deployment and lifecycle hooks
        const cfnService = new ecs.CfnService(this, 'Service', {
            cluster: cluster.clusterArn,
            serviceName: serviceName,
            taskDefinition: taskDefinition.taskDefinitionArn,
            desiredCount: 1,
            launchType: 'FARGATE',
            schedulingStrategy: 'REPLICA',
            networkConfiguration: {
                awsvpcConfiguration: {
                    subnets: vpc.privateSubnets.map(s => s.subnetId),
                    securityGroups: [props.networkingStack.ecsSecurityGroup.securityGroupId],
                    assignPublicIp: 'DISABLED',
                },
            },
            deploymentConfiguration: {
                minimumHealthyPercent: 100,
                maximumPercent: 200,
                strategy: 'BLUE_GREEN',
                bakeTimeInMinutes: 2,
                lifecycleHooks: [{
                    hookTargetArn: props.hookStack.trafficShiftFunctionArn,
                    roleArn: ecsLambdaInvokeRole.roleArn,
                    lifecycleStages: ['PRODUCTION_TRAFFIC_SHIFT'],
                }],
            },
        });

        // Ensure the service waits for the role to be ready
        cfnService.node.addDependency(ecsLambdaInvokeRole);

        // Public properties
        this.ecsClusterName = cluster.clusterName;
        this.ecsServiceName = serviceName;

        // Outputs
        new cdk.CfnOutput(this, 'ECSClusterName', {
            description: 'ECS Cluster Name',
            value: this.ecsClusterName
        });

        new cdk.CfnOutput(this, 'ECSServiceName', {
            description: 'ECS Service Name',
            value: this.ecsServiceName
        });

        new cdk.CfnOutput(this, 'ECSLogGroupName', {
            description: 'Log Group Name for ECS Tasks',
            value: ecsLogGroup.logGroupName
        });
    }
}

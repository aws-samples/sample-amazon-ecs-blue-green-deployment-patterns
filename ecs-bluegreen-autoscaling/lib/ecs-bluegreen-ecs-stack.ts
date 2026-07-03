import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import { EcsBluegreenNetworkingStack } from './ecs-bluegreen-networking-stack';
import { NagSuppressions } from "cdk-nag";

export interface EcsBluegreenEcsStackProps extends cdk.StackProps {
    networkingStack: EcsBluegreenNetworkingStack;
}

export class EcsBluegreenEcsStack extends cdk.Stack {
    public readonly ecsClusterName: string;
    public readonly ecsServiceName: string;

    constructor(scope: Construct, id: string, props: EcsBluegreenEcsStackProps) {
        super(scope, id, props);

        const vpc = props.networkingStack.vpc;
        const serviceName = 'bluegreendemo';

        // CloudWatch Log Group for tasks
        const ecsLogGroup = new logs.LogGroup(this, 'ECSLogGroup', {
            logGroupName: `/aws/ecs/service/${this.stackName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // IAM Role for ECS Task Execution
        const taskExecutionRole = new iam.Role(this, 'ECSTaskExecutionRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            path: '/'
        });

        taskExecutionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogStream',
                'logs:PutLogEvents'
            ],
            resources: [ecsLogGroup.logGroupArn]
        }));

        // IAM Role for ECS to modify ALB during blue/green deployments
        const ecsAlbRole = new iam.Role(this, 'ECSAlbRole', {
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('ecs.amazonaws.com')
            ),
            path: '/'
        });

        const describeAlbResourcesPolicies = new iam.ManagedPolicy(this, 'DescribeAlbPolicies', {
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'elasticloadbalancing:DescribeTargetGroups',
                        'elasticloadbalancing:DescribeTargetHealth',
                        'elasticloadbalancing:DescribeRules',
                        'elasticloadbalancing:DescribeListeners'
                    ],
                    resources: ['*']
                })
            ],
            roles: [ecsAlbRole]
        });

        ecsAlbRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'elasticloadbalancing:RegisterTargets',
                'elasticloadbalancing:DeregisterTargets'
            ],
            resources: [
                props.networkingStack.blueTargetGroup.targetGroupArn,
                props.networkingStack.greenTargetGroup.targetGroupArn
            ]
        }));

        ecsAlbRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['elasticloadbalancing:ModifyListener'],
            resources: [props.networkingStack.mainListener.listenerArn]
        }));

        ecsAlbRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['elasticloadbalancing:ModifyRule'],
            resources: [
                `arn:aws:elasticloadbalancing:${this.region}:${this.account}:listener-rule/app/*`,
            ]
        }));

        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/ECSAlbRole/DefaultPolicy/Resource`,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'The listener rule ARNs require wildcards as the rule ID is not known at synth time',
                appliesTo: [
                    `Resource::arn:aws:elasticloadbalancing:${this.region}:${this.account}:listener-rule/app/*`
                ]
            }]
        );

        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/DescribeAlbPolicies/Resource`,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'The ECS Control Plane requires a wildcard policy to describe the ALB resources',
                appliesTo: ['Resource::*']
            }],
            true
        );

        // ECS Cluster
        const cluster = new ecs.Cluster(this, 'ECSCluster', {
            vpc,
            containerInsightsV2: ecs.ContainerInsights.ENHANCED,
            enableFargateCapacityProviders: true
        });

        NagSuppressions.addResourceSuppressions(cluster, [{
            id: 'AwsSolutions-ECS4',
            reason: 'Container Insights Enhanced not yet supported in CDK Nag'
        }], true);

        // Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
            family: 'bluegreendemo',
            cpu: 512,
            memoryLimitMiB: 1024,
            executionRole: taskExecutionRole,
        });

        const container = taskDefinition.addContainer('retail-app', {
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-containers/retail-store-sample-ui:1.1.0'),
            portMappings: [{ containerPort: 8080 }],
            logging: ecs.LogDrivers.awsLogs({
                logGroup: ecsLogGroup,
                streamPrefix: 'retail-app',
            }),
        });

        NagSuppressions.addResourceSuppressions(taskDefinition, [{
            id: 'AwsSolutions-ECS2',
            reason: 'RETAIL_UI_THEME is a non-sensitive configuration value for the demo app',
        }], true);

        container.addEnvironment('RETAIL_UI_THEME', 'orange');

        // ECS Service with native blue/green deployment strategy (L1 construct required)
        const cfnService = new ecs.CfnService(this, 'Service', {
            cluster: cluster.clusterArn,
            serviceName: serviceName,
            taskDefinition: taskDefinition.taskDefinitionArn,
            desiredCount: 3,
            launchType: 'FARGATE',
            healthCheckGracePeriodSeconds: 60,
            schedulingStrategy: 'REPLICA',
            networkConfiguration: {
                awsvpcConfiguration: {
                    subnets: vpc.privateSubnets.map(s => s.subnetId),
                    securityGroups: [props.networkingStack.targetSecurityGroup.securityGroupId],
                    assignPublicIp: 'DISABLED',
                },
            },
            loadBalancers: [{
                targetGroupArn: props.networkingStack.blueTargetGroup.targetGroupArn,
                containerName: 'retail-app',
                containerPort: 8080,
                advancedConfiguration: {
                    alternateTargetGroupArn: props.networkingStack.greenTargetGroup.targetGroupArn,
                    productionListenerRule: props.networkingStack.productionListenerRuleArn,
                    roleArn: ecsAlbRole.roleArn,
                },
            }],
            deploymentConfiguration: {
                strategy: 'BLUE_GREEN',
                bakeTimeInMinutes: 3,
            },
        });

        // Ensure the service waits for the role and all its policies to be ready
        cfnService.node.addDependency(ecsAlbRole);
        cfnService.node.addDependency(describeAlbResourcesPolicies);

        // Application Auto Scaling for the ECS service
        const scalableTarget = new appscaling.CfnScalableTarget(this, 'ScalableTarget', {
            maxCapacity: 6,
            minCapacity: 3,
            resourceId: `service/${cluster.clusterName}/${serviceName}`,
            scalableDimension: 'ecs:service:DesiredCount',
            serviceNamespace: 'ecs',
        });
        scalableTarget.addDependency(cfnService);

        const REQUESTS_PER_TARGET_TARGET_VALUE = 4000; // requests per target per minute

        const scalingPolicy = new appscaling.CfnScalingPolicy(this, 'RequestCountScalingPolicy', {
            policyName: 'RequestCountPerTargetTracking',
            policyType: 'TargetTrackingScaling',
            scalableDimension: 'ecs:service:DesiredCount',
            serviceNamespace: 'ecs',
            resourceId: `service/${cluster.clusterName}/${serviceName}`,
            targetTrackingScalingPolicyConfiguration: {
                targetValue: REQUESTS_PER_TARGET_TARGET_VALUE,
                scaleInCooldown: 60,
                scaleOutCooldown: 60,
                customizedMetricSpecification: {
                    metrics: [
                        {
                            id: 'blue',
                            label: 'Blue target group requests per target',
                            returnData: false,
                            metricStat: {
                                stat: 'Sum',
                                metric: {
                                    namespace: 'AWS/ApplicationELB',
                                    metricName: 'RequestCountPerTarget',
                                    dimensions: [
                                        { name: 'TargetGroup', value: props.networkingStack.blueTargetGroup.targetGroupFullName },
                                        { name: 'LoadBalancer', value: props.networkingStack.alb.loadBalancerFullName },
                                    ],
                                },
                            },
                        },
                        {
                            id: 'green',
                            label: 'Green target group requests per target',
                            returnData: false,
                            metricStat: {
                                stat: 'Sum',
                                metric: {
                                    namespace: 'AWS/ApplicationELB',
                                    metricName: 'RequestCountPerTarget',
                                    dimensions: [
                                        { name: 'TargetGroup', value: props.networkingStack.greenTargetGroup.targetGroupFullName },
                                        { name: 'LoadBalancer', value: props.networkingStack.alb.loadBalancerFullName },
                                    ],
                                },
                            },
                        },
                        {
                            id: 'activeRequestsPerTarget',
                            label: 'Requests per target on the active target group',
                            expression: 'blue + green',
                            returnData: true,
                        },
                    ],
                },
            },
        });
        scalingPolicy.addDependency(scalableTarget);

        // Set public properties
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

        new cdk.CfnOutput(this, 'ECSAlbRoleArn', {
            description: 'ARN of the IAM Role for ECS to modify ALB',
            value: ecsAlbRole.roleArn
        });

        new cdk.CfnOutput(this, 'ECSLogGroupName', {
            description: 'Log Group Name for ECS Tasks',
            value: ecsLogGroup.logGroupName
        });
    }
}

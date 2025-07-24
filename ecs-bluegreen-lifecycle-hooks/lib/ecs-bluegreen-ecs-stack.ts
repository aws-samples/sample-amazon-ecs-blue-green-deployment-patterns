import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EcsBluegreenNetworkingStack } from './ecs-bluegreen-networking-stack';
import { EcsBluegreenHookStack } from './ecs-bluegreen-hook-stack';
import { NagSuppressions } from "cdk-nag";

export interface EcsBluegreenEcsStackProps extends cdk.StackProps {
    networkingStack: EcsBluegreenNetworkingStack;
    hookStack: EcsBluegreenHookStack;
}

export class EcsBluegreenEcsStack extends cdk.Stack {
    // Public properties to expose outputs
    public readonly ecsTaskExecutionRoleArn: string;
    public readonly ecsAlbRoleArn: string;
    public readonly ecsLambdaInvokeRoleArn: string;
    public readonly ecsLogGroupName: string;
    public readonly ecsClusterName: string;

    constructor(scope: Construct, id: string, props: EcsBluegreenEcsStackProps) {
        super(scope, id, props);

        // Get networking resources from the networking stack
        const vpc = props.networkingStack.vpc;

        // Create Cloudwatch Log Group for tasks
        const ecsLogGroup = new logs.LogGroup(this, 'ECSLogGroup', {
            logGroupName: `/aws/ecs/service/${this.stackName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // IAM Role for ECS Task Execution
        const ecsTaskExecutionRoleArn = new iam.Role(this, 'ECSTaskExecutionRole', {
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            ),
            path: '/'
        });

        ecsTaskExecutionRoleArn.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogStream',
                'logs:PutLogEvents'
            ],
            resources: [
                `${ecsLogGroup.logGroupArn}`
            ]
        }));

        // IAM Role for ECS to Modify ALB
        const ecsAlbRole = new iam.Role(this, 'ECSAlbRole', {
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('ecs.amazonaws.com')
            ),
            path: '/'
        });

        // Create a dedicated managed for DescribeTaskDefinition
        const describeAlbResourcesPolicies = new iam.ManagedPolicy(this, 'DescribeAlbPolicies', {
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'elasticloadbalancing:DescribeTargetGroups',
                        'elasticloadbalancing:DescribeTargetHealth',
                        'elasticloadbalancing:DescribeRules',
                        'elasticloadbalancing:DescribeListeners'],
                    resources: [
                        '*'
                    ]
                })
            ],
            roles: [ecsAlbRole]
        });

        // Write actions should be more restricted
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
            actions: [
                'elasticloadbalancing:ModifyListener'
            ],
            resources: [
                props.networkingStack.mainListener.listenerArn,
                props.networkingStack.testListener.listenerArn
            ]
        }));

        ecsAlbRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'elasticloadbalancing:ModifyRule'
            ],
            resources: [
                `${props.networkingStack.mainListener.listenerArn}/rules/*`,
                `${props.networkingStack.testListener.listenerArn}/rules/*`
            ]
        }));

        // Add nag suppressions directly to the policy statement with wildcards
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/ECSAlbRole/DefaultPolicy/Resource`,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'The listener rule ARNs require wildcards as the default listener rule ID is not available in CFN',
                    appliesTo: [
                        {
                            regex: '/^Resource::<ApplicationLoadBalancer[^>]*>\\/rules\\/\\*$/g',
                        },
                        `Resource::*`
                    ]
                }
            ]
        );

        // Add nag suppressions directly to the policy statement with wildcards
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/DescribeAlbPolicies/Resource`,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'The ECS Control Plane requires a wildcard policy to describe the ALB resources',
                    appliesTo: [
                        'Resource::*'
                    ]
                },
            ],
            true
        );

        // IAM Role for ECS to invoke Lambda
        const ecsLambdaInvokeRole = new iam.Role(this, 'ECSLambdaInvokeRole', {
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('ecs.amazonaws.com')
            ),
            path: '/'
        });

        ecsLambdaInvokeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['lambda:InvokeFunction'],
            resources: [
                props.hookStack.approvalFunctionArn,
                props.hookStack.admissionFunctionArn,
                props.hookStack.canaryFunctionArn
            ]
        }));

        // Create ECS Cluster
        const cluster = new ecs.Cluster(this, 'ECSCluster', {
            vpc,
            containerInsightsV2: ecs.ContainerInsights.ENHANCED,
            enableFargateCapacityProviders: true
        });

        NagSuppressions.addResourceSuppressions(
            cluster,
            [
                {
                    id: 'AwsSolutions-ECS4',
                    reason: 'Container Insights Enhanced not yet supported in CDK Nag'
                },
            ],
            true
        );

        // Set public properties for outputs
        this.ecsTaskExecutionRoleArn = ecsTaskExecutionRoleArn.roleArn;
        this.ecsAlbRoleArn = ecsAlbRole.roleArn;
        this.ecsLambdaInvokeRoleArn = ecsLambdaInvokeRole.roleArn;
        this.ecsLogGroupName = ecsLogGroup.logGroupName;
        this.ecsClusterName = cluster.clusterName;

        // Outputs
        new cdk.CfnOutput(this, 'ECSTaskExecutionRoleArn', {
            description: 'ARN of the IAM Role for ECS Task Execution Role',
            value: this.ecsTaskExecutionRoleArn
        });

        new cdk.CfnOutput(this, 'ECSAlbRoleArn', {
            description: 'ARN of the IAM Role for ECS to modify ALB',
            value: this.ecsAlbRoleArn
        });

        new cdk.CfnOutput(this, 'ECSLambdaInvokeRoleArn', {
            description: 'ARN of the IAM Role for ECS to invoke Lambda',
            value: this.ecsLambdaInvokeRoleArn
        });

        new cdk.CfnOutput(this, 'ECSLogGroupName', {
            description: 'Log Group Name for ECS Tasks',
            value: this.ecsLogGroupName
        });

        new cdk.CfnOutput(this, 'ECSClusterName', {
            description: 'ECS Cluster Name',
            value: this.ecsClusterName
        });
    }
}

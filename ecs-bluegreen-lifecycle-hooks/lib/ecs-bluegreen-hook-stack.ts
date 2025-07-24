import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from "cdk-nag";

export interface EcsBluegreenHookStackProps extends cdk.StackProps {
    // Optional properties that can be passed to the stack
}

export class EcsBluegreenHookStack extends cdk.Stack {
    // Public properties to expose outputs
    public readonly approvalFunctionArn: string;
    public readonly admissionFunctionArn: string;
    public readonly canaryFunctionArn: string;

    constructor(scope: Construct, id: string, props?: EcsBluegreenHookStackProps) {
        super(scope, id, props);

        // Create S3 bucket for approval files
        const approvalBucket = new s3.Bucket(this, 'ApprovalBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            versioned: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
        });

        NagSuppressions.addResourceSuppressions(approvalBucket, [{
            id: "AwsSolutions-S1",
            reason: "Skipping S3 Access Logs for the demo",
        }]);

        // Create Docker image assets for Lambda functions
        const approvalFunctionAsset = new ecr_assets.DockerImageAsset(this, 'approvalFunctionImage', {
            directory: path.join(__dirname, '../src/approvalFunction'),
            file: 'Dockerfile',
        });

        const admissionFunctionAsset = new ecr_assets.DockerImageAsset(this, 'admissionFunctionImage', {
            directory: path.join(__dirname, '../src/admissionFunction'),
            file: 'Dockerfile',
        });

        const canaryFunctionAsset = new ecr_assets.DockerImageAsset(this, 'canaryFunctionImage', {
            directory: path.join(__dirname, '../src/canaryFunction'),
            file: 'Dockerfile',
        });

        // Define function names
        const approvalFunctionName = 'EcsBluegreenHookStack-approvalFunction';
        const admissionFunctionName = 'EcsBluegreenHookStack-admissionFunction';
        const canaryFunctionName = 'EcsBluegreenHookStack-canaryFunction';

        // Create log groups ahead of time
        const approvalFunctionLogGroup = new logs.LogGroup(this, 'approvalFunctionLogGroup', {
            logGroupName: `/aws/lambda/${approvalFunctionName}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.ONE_WEEK,
        });

        const admissionFunctionLogGroup = new logs.LogGroup(this, 'admissionFunctionLogGroup', {
            logGroupName: `/aws/lambda/${admissionFunctionName}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.ONE_WEEK,
        });

        const canaryFunctionLogGroup = new logs.LogGroup(this, 'canaryFunctionLogGroup', {
            logGroupName: `/aws/lambda/${canaryFunctionName}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.ONE_WEEK,
        });

        // Create log retention role
        const logRetentionRole = new iam.Role(this, 'logRetentionRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        // Add permissions for log retention - scoped to specific log groups
        logRetentionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:PutRetentionPolicy'
            ],
            resources: [
                approvalFunctionLogGroup.logGroupArn,
                admissionFunctionLogGroup.logGroupArn,
                canaryFunctionLogGroup.logGroupArn
            ]
        }));

        // Create a role for the approval function
        const approvalFunctionRole = new iam.Role(this, 'ApprovalFunctionRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Role for ECS blue/green deployment approval function',
        });

        // Add permissions for CloudWatch Logs - scoped to specific log group
        approvalFunctionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogStream',
                'logs:PutLogEvents'
            ],
            resources: [
                approvalFunctionLogGroup.logGroupArn,
            ]
        }));

        // Add permissions for ECS operations needed by the approval function
        approvalFunctionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ecs:ListServiceDeployments'
            ],
            resources: [
                `arn:aws:ecs:${this.region}:${this.account}:service/*`
            ]
        }));

        // Add permissions for S3 operations needed by the approval function
        approvalFunctionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:HeadObject',
                's3:GetObject',
                's3:ListBucket'
            ],
            resources: [
                approvalBucket.bucketArn,
                `${approvalBucket.bucketArn}/*`
            ],
        }));

        // Add nag suppressions directly to the role
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/ApprovalFunctionRole/DefaultPolicy/Resource`,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'ECS Service is not known at this time and is deployed manually in the blog',
                    appliesTo: [
                        `Resource::arn:aws:ecs:${this.region}:${this.account}:service/*`
                    ]
                },
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'The role is scoped down to a bucket, but not objects in the bucket',
                    appliesTo: [
                        {
                            regex: '/^Resource::<ApprovalBucket[^>]*>\\/\\*$/g',
                        },
                    ]
                },
            ],
            true
        );

        // Create a Role for the admission function
        const admissionFunctionRole = new iam.Role(this, 'AdmissionFunctionRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Role for ECS blue/green deployment admission function',
        });

        // Add permissions for CloudWatch Logs - scoped to specific log group
        admissionFunctionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogStream',
                'logs:PutLogEvents'
            ],
            resources: [
                admissionFunctionLogGroup.logGroupArn,
            ]
        }));

        // Create a dedicated policy for DescribeTaskDefinition
        const describeTaskDefinitionPolicy = new iam.ManagedPolicy(this, 'DescribeTaskDefinitionPolicy', {
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'ecs:DescribeTaskDefinition'
                    ],
                    resources: [
                        '*'
                    ]
                })
            ],
            roles: [admissionFunctionRole]
        });

        // For DescribeServiceRevisions, we can scope to specific services if known
        admissionFunctionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ecs:DescribeServiceRevisions'
            ],
            resources: [
                `arn:aws:ecs:${this.region}:${this.account}:task-definition/*`,
                `arn:aws:ecs:${this.region}:${this.account}:service/*`,
                `arn:aws:ecs:${this.region}:${this.account}:service-revision/*`
            ]
        }));

        // Add nag suppressions directly to the role
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/AdmissionFunctionRole/DefaultPolicy/Resource`,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'ECS Service is not known at this time and is deployed manually in the blog',
                    appliesTo: [
                        `Resource::arn:aws:ecs:${this.region}:${this.account}:task-definition/*`,
                        `Resource::arn:aws:ecs:${this.region}:${this.account}:service/*`,
                        `Resource::arn:aws:ecs:${this.region}:${this.account}:service-revision/*`
                    ]
                },
            ],
            true
        );

        // Add nag suppressions for the dedicated DescribeTaskDefinition policy
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/DescribeTaskDefinitionPolicy/Resource`,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'The describe task definition call requires a wildcard resource',
                    appliesTo: [
                        'Resource::*'
                    ]
                },
            ],
            true
        );

        // Create a Role for the canary function
        const canaryFunctionRole = new iam.Role(this, 'CanaryFunctionRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Role for ECS blue/green deployment canary function',
        });

        // Add permissions for CloudWatch Logs - scoped to specific log group
        canaryFunctionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogStream',
                'logs:PutLogEvents'
            ],
            resources: [
                canaryFunctionLogGroup.logGroupArn,
            ]
        }));

        // Add permissions for ECS operations needed by the approval function
        canaryFunctionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ecs:ListServiceDeployments'
            ],
            resources: [
                `arn:aws:ecs:${this.region}:${this.account}:service/*`
            ]
        }));

        // Add permissions for ECS operations needed by the canary function
        canaryFunctionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ecs:DescribeServiceRevisions'
            ],
            resources: [
                `arn:aws:ecs:${this.region}:${this.account}:task-definition/*`,
                `arn:aws:ecs:${this.region}:${this.account}:service/*`,
                `arn:aws:ecs:${this.region}:${this.account}:service-revision/*`
            ]
        }));

        // Add modifyListener permissions to canary function
        canaryFunctionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'elasticloadbalancing:ModifyListener'
            ],
            resources: [
                `arn:aws:elasticloadbalancing:${this.region}:${this.account}:listener/app/*`,
            ]
        }));

        // Add nag suppressions for the canary function role
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/CanaryFunctionRole/DefaultPolicy/Resource`,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'ECS Service and Load Balancer resources are not known at this time and are deployed manually',
                    appliesTo: [
                        `Resource::arn:aws:ecs:${this.region}:${this.account}:task-definition/*`,
                        `Resource::arn:aws:ecs:${this.region}:${this.account}:service/*`,
                        `Resource::arn:aws:ecs:${this.region}:${this.account}:service-revision/*`,
                        `Resource::arn:aws:elasticloadbalancing:${this.region}:${this.account}:listener/app/*`
                    ]
                },
            ],
            true
        );

        // Create a dedicated policy for DescribeRules as it needs a wildcard on resources
        const describeRulesPolicy = new iam.ManagedPolicy(this, 'DescribeRulesPolicy', {
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'elasticloadbalancing:DescribeRules',
                    ],
                    resources: [
                        '*'
                    ]
                })
            ],
            roles: [canaryFunctionRole]
        });

        // Add nag suppressions for the canary function role
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/DescribeRulesPolicy/Resource`,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'The Describe Rule requires a wildcard resource policy',
                    appliesTo: [
                        'Resource::*'
                    ]
                },
            ],
            true
        );

        // Create Lambda functions using container images with their respective roles
        const approvalFunction = new lambda.DockerImageFunction(this, 'approvalFunction', {
            code: lambda.DockerImageCode.fromEcr(approvalFunctionAsset.repository, {
                tagOrDigest: approvalFunctionAsset.imageTag,
            }),
            timeout: cdk.Duration.seconds(45),
            memorySize: 128,
            environment: {
                POWERTOOLS_SERVICE_NAME: 'ECS_INIT_FUNCTION',
                S3_BUCKET: approvalBucket.bucketName,
            },
            functionName: approvalFunctionName,
            role: approvalFunctionRole,
            logGroup: approvalFunctionLogGroup,
        });

        const admissionFunction = new lambda.DockerImageFunction(this, 'admissionFunction', {
            code: lambda.DockerImageCode.fromEcr(admissionFunctionAsset.repository, {
                tagOrDigest: admissionFunctionAsset.imageTag,
            }),
            timeout: cdk.Duration.seconds(45),
            memorySize: 128,
            environment: {
                POWERTOOLS_SERVICE_NAME: 'ECS_ADMISSION_FUNCTION',
            },
            functionName: admissionFunctionName,
            role: admissionFunctionRole,
            logGroup: admissionFunctionLogGroup,
        });

        const canaryFunction = new lambda.DockerImageFunction(this, 'canaryFunction', {
            code: lambda.DockerImageCode.fromEcr(canaryFunctionAsset.repository, {
                tagOrDigest: canaryFunctionAsset.imageTag,
            }),
            timeout: cdk.Duration.seconds(60),
            memorySize: 128,
            environment: {
                POWERTOOLS_SERVICE_NAME: 'ECS_CANARY_FUNCTION',
            },
            functionName: canaryFunctionName,
            role: canaryFunctionRole,
            logGroup: canaryFunctionLogGroup,
        });

        // Set public properties for outputs
        this.approvalFunctionArn = approvalFunction.functionArn;
        this.admissionFunctionArn = admissionFunction.functionArn;
        this.canaryFunctionArn = canaryFunction.functionArn;

        // Outputs
        new cdk.CfnOutput(this, 'ApprovalFunction', {
            description: 'Arn of Approval Function',
            value: this.approvalFunctionArn,
        });

        new cdk.CfnOutput(this, 'AdmissionFunction', {
            description: 'Arn of Admission Function',
            value: this.admissionFunctionArn,
        });

        new cdk.CfnOutput(this, 'CanaryFunction', {
            description: 'Arn of Canary Function',
            value: this.canaryFunctionArn,
        });

        // Export the bucket name for reference
        new cdk.CfnOutput(this, 'ApprovalBucketName', {
            value: approvalBucket.bucketName,
            description: 'The name of the S3 bucket used for deployment approvals',
            exportName: 'ApprovalBucketName',
        });
    }
}

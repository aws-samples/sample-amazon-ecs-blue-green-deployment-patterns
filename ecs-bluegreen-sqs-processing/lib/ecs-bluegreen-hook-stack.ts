import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import { NagSuppressions } from "cdk-nag";

export interface EcsBluegreenHookStackProps extends cdk.StackProps {
}

export class EcsBluegreenHookStack extends cdk.Stack {
    // Public properties to expose outputs
    public readonly trafficShiftFunctionArn: string;
    public readonly sqsQueue: sqs.Queue;

    constructor(scope: Construct, id: string, props?: EcsBluegreenHookStackProps) {
        super(scope, id, props);

        // ─────────────────────────────────────────────────────────────────────
        // SQS Queue
        // ─────────────────────────────────────────────────────────────────────

        this.sqsQueue = new sqs.Queue(this, 'SqsQueue', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        NagSuppressions.addResourceSuppressions(this.sqsQueue, [{
            id: "AwsSolutions-SQS3",
            reason: "No DLQ needed for this demo pattern — failed messages return to queue after visibility timeout",
        }, {
            id: "AwsSolutions-SQS4",
            reason: "No encryption needed for this demo pattern",
        }]);

        // ─────────────────────────────────────────────────────────────────────
        // Docker image asset for the traffic shift Lambda function
        // ─────────────────────────────────────────────────────────────────────

        const trafficShiftFunctionAsset = new ecr_assets.DockerImageAsset(this, 'trafficShiftFunctionImage', {
            directory: path.join(__dirname, '../src/trafficShiftFunction'),
            file: 'Dockerfile',
        });

        // ─────────────────────────────────────────────────────────────────────
        // Function name and log group
        // ─────────────────────────────────────────────────────────────────────

        const trafficShiftFunctionName = 'EcsBluegreenHookStack-trafficShiftFunction';

        const trafficShiftFunctionLogGroup = new logs.LogGroup(this, 'trafficShiftFunctionLogGroup', {
            logGroupName: `/aws/lambda/${trafficShiftFunctionName}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.ONE_WEEK,
        });

        // ─────────────────────────────────────────────────────────────────────
        // Traffic Shift Function IAM Role
        // ─────────────────────────────────────────────────────────────────────

        const trafficShiftFunctionRole = new iam.Role(this, 'TrafficShiftFunctionRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Role for ECS blue/green deployment traffic shift function',
        });

        // CloudWatch Logs permissions scoped to specific log group
        trafficShiftFunctionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogStream',
                'logs:PutLogEvents'
            ],
            resources: [
                trafficShiftFunctionLogGroup.logGroupArn,
            ]
        }));

        // SSM permissions for read/write under /myapp/sqs-processing-enabled/*
        trafficShiftFunctionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetParameter',
                'ssm:PutParameter',
                'ssm:GetParametersByPath'
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter/myapp/sqs-processing-enabled/*`
            ]
        }));

        // cdk-nag suppressions for traffic shift function role
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/TrafficShiftFunctionRole/DefaultPolicy/Resource`,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'SSM parameter path uses wildcard because deployment IDs are not known at deploy time',
                },
            ],
            true
        );

        // ─────────────────────────────────────────────────────────────────────
        // Lambda Function
        // ─────────────────────────────────────────────────────────────────────

        const trafficShiftFunction = new lambda.DockerImageFunction(this, 'trafficShiftFunction', {
            code: lambda.DockerImageCode.fromEcr(trafficShiftFunctionAsset.repository, {
                tagOrDigest: trafficShiftFunctionAsset.imageTag,
            }),
            timeout: cdk.Duration.seconds(45),
            memorySize: 128,
            environment: {
                POWERTOOLS_SERVICE_NAME: 'ECS_TRAFFIC_SHIFT_FUNCTION',
            },
            functionName: trafficShiftFunctionName,
            role: trafficShiftFunctionRole,
            logGroup: trafficShiftFunctionLogGroup,
        });

        // ─────────────────────────────────────────────────────────────────────
        // Public properties
        // ─────────────────────────────────────────────────────────────────────

        this.trafficShiftFunctionArn = trafficShiftFunction.functionArn;

        // ─────────────────────────────────────────────────────────────────────
        // CfnOutputs
        // ─────────────────────────────────────────────────────────────────────

        new cdk.CfnOutput(this, 'SqsQueueUrl', {
            description: 'URL of the SQS Queue',
            value: this.sqsQueue.queueUrl,
        });

        new cdk.CfnOutput(this, 'SqsQueueArn', {
            description: 'ARN of the SQS Queue',
            value: this.sqsQueue.queueArn,
        });

        new cdk.CfnOutput(this, 'TrafficShiftFunctionArn', {
            description: 'ARN of the Traffic Shift Function',
            value: this.trafficShiftFunctionArn,
        });
    }
}

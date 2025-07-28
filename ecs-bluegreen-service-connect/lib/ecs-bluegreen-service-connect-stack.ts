import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { join } from 'path'

export interface CdkBlueGreenStackProps extends cdk.StackProps {
    yourIpAddress?: string;
}

export class EcsBlueGreenServiceConnectStack extends cdk.Stack {

    public readonly vpc: ec2.IVpc;
    public readonly albSecurityGroup: ec2.SecurityGroup;
    public readonly frontendSecurityGroup: ec2.SecurityGroup;
    public readonly backendSecurityGroup: ec2.SecurityGroup;
    public readonly publicSubnets: ec2.ISubnet[];
    public readonly privateSubnets: ec2.ISubnet[];
    public readonly alb: elbv2.ApplicationLoadBalancer;
    public readonly blueGreenTargetGroup: elbv2.IApplicationTargetGroup;
    public readonly taskExecutionRole: iam.Role;
    public readonly ecsLambdaInvokeRole: iam.Role;
    public readonly lambdaExecutionRole: iam.Role;
    public readonly lambdaLogGroup: logs.LogGroup;
    public readonly taskLogGroup: logs.LogGroup;
    public readonly lifeCycleHookLambdaFunction: lambda.Function;

    constructor(scope: Construct, id: string, props: CdkBlueGreenStackProps = {}) {
        super(scope, id, props);

        const yourIpAddress = props?.yourIpAddress || '0.0.0.0/0';

        // Create new VPC with 2 public and 2 private subnets
        this.vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 2,
            natGateways: 2,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                }
            ]
        });
        this.vpc.addFlowLog("FlowLogs", {
            destination: ec2.FlowLogDestination.toCloudWatchLogs(),
            trafficType: ec2.FlowLogTrafficType.REJECT
        });
        this.privateSubnets = this.vpc.privateSubnets;
        this.publicSubnets = this.vpc.publicSubnets;

        // Create ECS Cluster
        const cluster = new ecs.Cluster(this, 'ECSCluster', {
            vpc: this.vpc,
            containerInsightsV2: ecs.ContainerInsights.ENABLED,
            enableFargateCapacityProviders: true
        });

        cluster.addDefaultCloudMapNamespace({
            name: "bluegreen.local"
        })

        // Security Group for ALB
        this.albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
            vpc: this.vpc,
            description: 'Security group for ALB',
            allowAllOutbound: true,
        });

        this.albSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(yourIpAddress),
            ec2.Port.tcp(80),
            'Allow HTTP traffic from specified IP'
        );

        // Security Group for Frontend Tasks
        this.frontendSecurityGroup = new ec2.SecurityGroup(this, 'FrontendSecurityGroup', {
            vpc: this.vpc,
            description: 'Security group for frontend tasks',
            allowAllOutbound: true,
        });

        this.frontendSecurityGroup.addIngressRule(
            ec2.Peer.securityGroupId(this.albSecurityGroup.securityGroupId),
            ec2.Port.tcp(80),
            'Allow HTTP traffic from ALB'
        );

        // Security Group for Backend Tasks
        this.backendSecurityGroup = new ec2.SecurityGroup(this, 'BackendSecurityGroup', {
            vpc: this.vpc,
            description: 'Security group for backend tasks',
            allowAllOutbound: true,
        });

        this.backendSecurityGroup.addIngressRule(
            ec2.Peer.securityGroupId(this.frontendSecurityGroup.securityGroupId),
            ec2.Port.tcp(80),
            'Allow HTTP traffic from Frontend Tasks'
        );

        // Application Load Balancer
        this.alb = new elbv2.ApplicationLoadBalancer(this, 'ApplicationLoadBalancer', {
            vpc: this.vpc,
            internetFacing: true,
            securityGroup: this.albSecurityGroup,
            vpcSubnets: {
                subnets: this.publicSubnets
            },
            loadBalancerName: 'BlueGreenALB',
            idleTimeout: cdk.Duration.seconds(60)
        });

        this.alb.logAccessLogs(new s3.Bucket(this, 'ApplicationLoadBalancerAccessLogs', {
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            serverAccessLogsBucket: new s3.Bucket(this, 'S3ServerAccessLogs', {
                encryption: s3.BucketEncryption.S3_MANAGED,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                enforceSSL: true,
                autoDeleteObjects: true,
            })
        }));

        // Target Groups
        this.blueGreenTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BlueGreenTargetGroup', {
            vpc: this.vpc,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/',
                protocol: elbv2.Protocol.HTTP,
                port: 'traffic-port',
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 2,
            },
            targetGroupName: 'BlueGreenTargetGroup',
            deregistrationDelay: cdk.Duration.seconds(20)
        });

        this.alb.addListener('Listener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.forward([this.blueGreenTargetGroup])
        });

        this.taskLogGroup = new logs.LogGroup(this, "TaskLogGroup", {
            retention: logs.RetentionDays.FIVE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        this.taskExecutionRole = new iam.Role(this, "ECSTaskExecutionRole", {
            assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
            description: "ECS Task Execution Role",
        });

        this.taskExecutionRole.assumeRolePolicy?.addStatements(
            new iam.PolicyStatement({
                sid: "",
                effect: iam.Effect.ALLOW,
                actions: ["sts:AssumeRole"],
                principals: [
                    new iam.ServicePrincipal("ecs-tasks.amazonaws.com")
                ]
            })
        );

        this.taskExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "ecr:GetAuthorizationToken",
                    "ecr:BatchCheckLayerAvailability",
                    "ecr:GetDownloadUrlForLayer",
                    "ecr:BatchGetImage",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents"
                ],
                resources: [
                    this.taskLogGroup.logGroupArn
                ]
            })
        )

        this.lambdaLogGroup = new logs.LogGroup(this, "LambdaLogGroup", {
            retention: logs.RetentionDays.FIVE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        this.lambdaExecutionRole = new iam.Role(this, "LambdaExecutionRole", {
            assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
            description: "Lambda Default Task Execution Role",
        });

        this.lambdaExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "logs:CreateLogStream",
                    "logs:PutLogEvents"
                ],
                resources: [this.lambdaLogGroup.logGroupArn]
            })
        );

        this.ecsLambdaInvokeRole = new iam.Role(this, "EcsLambdaInvokeRole", {
            assumedBy: new iam.ServicePrincipal("ecs.amazonaws.com"),
            description: "ECS Lambda Invoke Role",
        },
        );

        this.ecsLambdaInvokeRole.assumeRolePolicy?.addStatements(
            new iam.PolicyStatement({
                sid: "",
                effect: iam.Effect.ALLOW,
                actions: ["sts:AssumeRole"],
                principals: [
                    new iam.ServicePrincipal("ecs.amazonaws.com")
                ]
            })
        );

        this.lifeCycleHookLambdaFunction = new lambda.Function(this, 'LifeCycleHook', {
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'lambda_function.lambda_handler',
            code: lambda.Code.fromAsset(join(__dirname, '../lifecycleHookLambda/my_deployment_package.zip')),
            logGroup: this.lambdaLogGroup,
            role: this.lambdaExecutionRole,
            environment: {
                "ALB_URL": "http://" + this.alb.loadBalancerDnsName,
                "MATCHING_HEADER": "test"
            }
        });

        this.ecsLambdaInvokeRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "lambda:InvokeFunction",
                ],
                resources: [this.lifeCycleHookLambdaFunction.functionArn]
            })
        );

        new cdk.CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
        new cdk.CfnOutput(this, "SubnetId1", { value: this.privateSubnets[0].subnetId });
        new cdk.CfnOutput(this, "SubnetId2", { value: this.privateSubnets[1].subnetId });
        new cdk.CfnOutput(this, "AlbSecGroupId", { value: this.albSecurityGroup.securityGroupId });
        new cdk.CfnOutput(this, "FrontendSecGroupId", { value: this.frontendSecurityGroup.securityGroupId });
        new cdk.CfnOutput(this, "BackendSecGroupId", { value: this.backendSecurityGroup.securityGroupId });
        new cdk.CfnOutput(this, "BlueGreenTargetGroupArn", { value: this.blueGreenTargetGroup.targetGroupArn });
        new cdk.CfnOutput(this, "AlbArn", { value: this.alb.loadBalancerArn });
        new cdk.CfnOutput(this, "AlbDns", { value: this.alb.loadBalancerDnsName });
        new cdk.CfnOutput(this, "TaskExecutionRoleArn", { value: this.taskExecutionRole.roleArn });
        new cdk.CfnOutput(this, "TaskLogGroupName", { value: this.taskLogGroup.logGroupName });
        new cdk.CfnOutput(this, "LambdaLogGroupName", { value: this.lambdaLogGroup.logGroupName });
        new cdk.CfnOutput(this, "LambdaLogGroupArn", { value: this.lambdaLogGroup.logGroupArn });
        new cdk.CfnOutput(this, "LifeCycleHookLambdaFunction", { value: this.lifeCycleHookLambdaFunction.functionArn });
        new cdk.CfnOutput(this, "EcsLambdaInvokeRoleArn", { value: this.ecsLambdaInvokeRole.roleArn });
        new cdk.CfnOutput(this, "ECSClusterName", { value: cluster.clusterName });
    }
}

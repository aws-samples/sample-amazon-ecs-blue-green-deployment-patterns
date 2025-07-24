import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from "cdk-nag";

export interface EcsBluegreenNetworkingStackProps extends cdk.StackProps {
    yourIpAddress?: string;
    region?: string;
}

export class EcsBluegreenNetworkingStack extends cdk.Stack {
    // Public properties to expose resources to other stacks
    public readonly vpc: ec2.IVpc;
    public readonly albSecurityGroup: ec2.SecurityGroup;
    public readonly targetSecurityGroup: ec2.SecurityGroup;
    public readonly publicSubnets: ec2.ISubnet[];
    public readonly alb: elbv2.ApplicationLoadBalancer;
    public readonly blueTargetGroup: elbv2.IApplicationTargetGroup;
    public readonly greenTargetGroup: elbv2.IApplicationTargetGroup;
    public readonly mainListener: elbv2.IApplicationListener;
    public readonly testListener: elbv2.IApplicationListener;

    constructor(scope: Construct, id: string, props?: EcsBluegreenNetworkingStackProps) {
        super(scope, id, props);

        // Default values for parameters
        const yourIpAddress = props?.yourIpAddress || '0.0.0.0/0';

        // Create new VPC with 3 public and 3 private subnets
        this.vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 3,
            natGateways: 3,
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
        this.publicSubnets = this.vpc.publicSubnets;

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

        this.albSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(yourIpAddress),
            ec2.Port.tcp(8080),
            'Allow traffic on port 8080 from specified IP'
        );
        NagSuppressions.addResourceSuppressions(this.albSecurityGroup, [{
            id: "AwsSolutions-EC23",
            reason: "This ALB need to be publicly accessible",
        }]);

        // Security Group for Target Instances
        this.targetSecurityGroup = new ec2.SecurityGroup(this, 'TargetSecurityGroup', {
            vpc: this.vpc,
            description: 'Security group for target instances',
            allowAllOutbound: true,
        });

        this.targetSecurityGroup.addIngressRule(
            ec2.Peer.securityGroupId(this.albSecurityGroup.securityGroupId),
            ec2.Port.tcp(8080),
            'Allow traffic on port 8080 from ALB'
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
        this.blueTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BlueTargetGroup', {
            vpc: this.vpc,
            port: 8080,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/actuator/health',
                protocol: elbv2.Protocol.HTTP,
                port: 'traffic-port',
                interval: cdk.Duration.seconds(10),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 2,
            },
            targetGroupName: 'BlueTargetGroup',
            deregistrationDelay: cdk.Duration.seconds(20)
        });

        this.greenTargetGroup = new elbv2.ApplicationTargetGroup(this, 'GreenTargetGroup', {
            vpc: this.vpc,
            port: 8080,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/actuator/health',
                protocol: elbv2.Protocol.HTTP,
                port: 'traffic-port',
                interval: cdk.Duration.seconds(10),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 2,
            },
            targetGroupName: 'GreenTargetGroup',
            deregistrationDelay: cdk.Duration.seconds(20)
        });

        // ALB Listener with weighted target groups
        this.mainListener = this.alb.addListener('ALBListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.weightedForward([
                {
                    targetGroup: this.blueTargetGroup,
                    weight: 100
                },
                {
                    targetGroup: this.greenTargetGroup,
                    weight: 0
                }
            ])
        });

        // Test ALB Listener
        this.testListener = this.alb.addListener('TestALBListener', {
            port: 8080,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.weightedForward([
                {
                    targetGroup: this.blueTargetGroup,
                    weight: 100
                },
                {
                    targetGroup: this.greenTargetGroup,
                    weight: 0
                }
            ])
        });

        // Outputs
        new cdk.CfnOutput(this, 'VpcId', {
            description: 'ID of the VPC',
            value: this.vpc.vpcId
        });

        new cdk.CfnOutput(this, 'PrivateSubnet1Id', {
            description: 'ID of the first private subnet',
            value: this.vpc.privateSubnets[0].subnetId
        });

        new cdk.CfnOutput(this, 'PrivateSubnet2Id', {
            description: 'ID of the second private subnet',
            value: this.vpc.privateSubnets[1].subnetId
        });

        new cdk.CfnOutput(this, 'ALBSecurityGroupId', {
            description: 'ID of the ALB Security Group',
            value: this.albSecurityGroup.securityGroupId
        });

        new cdk.CfnOutput(this, 'TargetSecurityGroupId', {
            description: 'ID of the Target Security Group',
            value: this.targetSecurityGroup.securityGroupId
        });

        new cdk.CfnOutput(this, 'ALBDNSName', {
            description: 'DNS Name of the Application Load Balancer',
            value: this.alb.loadBalancerDnsName
        });

        new cdk.CfnOutput(this, 'ALbArn', {
            description: 'ARN of the Application Load Balancer',
            value: this.alb.loadBalancerArn
        });

        new cdk.CfnOutput(this, 'BlueTargetGroupArn', {
            description: 'ARN of the Blue Target Group',
            value: this.blueTargetGroup.targetGroupArn
        });

        new cdk.CfnOutput(this, 'GreenTargetGroupArn', {
            description: 'ARN of the Green Target Group',
            value: this.greenTargetGroup.targetGroupArn
        });
    }
}

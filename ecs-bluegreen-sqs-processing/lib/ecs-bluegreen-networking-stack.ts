import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { NagSuppressions } from "cdk-nag";

export class EcsBluegreenNetworkingStack extends cdk.Stack {
    // Public properties to expose resources to other stacks
    public readonly vpc: ec2.IVpc;
    public readonly ecsSecurityGroup: ec2.SecurityGroup;
    public readonly privateSubnets: ec2.ISubnet[];

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Create VPC with 3 AZs, public and private subnets
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
        this.privateSubnets = this.vpc.privateSubnets;

        // Security Group for ECS tasks — no inbound rules (headless worker), all outbound allowed
        this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
            vpc: this.vpc,
            description: 'Security group for ECS tasks - no inbound, all outbound',
            allowAllOutbound: true,
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

        new cdk.CfnOutput(this, 'EcsSecurityGroupId', {
            description: 'ID of the ECS Security Group',
            value: this.ecsSecurityGroup.securityGroupId
        });
    }
}

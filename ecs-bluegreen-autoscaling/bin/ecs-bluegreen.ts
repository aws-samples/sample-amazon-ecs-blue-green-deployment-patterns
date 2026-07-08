#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcsBluegreenNetworkingStack } from '../lib/ecs-bluegreen-networking-stack';
import { EcsBluegreenEcsStack } from '../lib/ecs-bluegreen-ecs-stack';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Aspects } from 'aws-cdk-lib';

const app = new cdk.App();
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Get parameters from context or use defaults
const yourIpAddress = app.node.tryGetContext('yourIpAddress') || '0.0.0.0/0';
const region = app.node.tryGetContext('region') || 'eu-west-1';

// Create the networking stack
const networkingStack = new EcsBluegreenNetworkingStack(app, 'EcsBluegreenNetworkingStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: region },
    yourIpAddress,
});

// Create the ECS stack that depends on the networking stack
const ecsStack = new EcsBluegreenEcsStack(app, 'EcsBluegreenEcsStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: region },
    networkingStack: networkingStack,
});

ecsStack.addDependency(networkingStack);

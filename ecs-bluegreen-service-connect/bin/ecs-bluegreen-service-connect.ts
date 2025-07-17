#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcsBlueGreenServiceConnectStack } from '../lib/ecs-bluegreen-service-connect-stack';

const app = new cdk.App();

const yourIpAddress = app.node.tryGetContext('yourIpAddress') || '0.0.0.0/0';
const region = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION;

new EcsBlueGreenServiceConnectStack(app, 'EcsBlueGreenServiceConnectStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: region },
    yourIpAddress,
});
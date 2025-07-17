#!/bin/bash

CF_OUTPUT=$(aws cloudformation describe-stacks \
    --stack-name EcsBlueGreenServiceConnectStack --query "Stacks[0].Outputs")

export VPC_ID=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="VpcId") .OutputValue')
export SUBNET_ID1=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="SubnetId1") .OutputValue')
export SUBNET_ID2=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="SubnetId2") .OutputValue')
export ALB_SG=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="AlbSecGroupId") .OutputValue')
export FRONTEND_SG=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="FrontendSecGroupId") .OutputValue')
export BACKEND_SG=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="BackendSecGroupId") .OutputValue')
export BLUE_GREEN_TARGET_GROUP=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="BlueGreenTargetGroupArn") .OutputValue')
export ALB_ARN=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="AlbArn") .OutputValue')
export ALB_DNS=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="AlbDns") .OutputValue')
export TASK_EXECUTION_ROLE=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="TaskExecutionRoleArn") .OutputValue')
export TASK_LOG_GROUP_NAME=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="TaskLogGroupName") .OutputValue')
export LAMBDA_LOG_GROUP_NAME=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="LambdaLogGroupName") .OutputValue')
export LAMBDA_LOG_GROUP_ARN=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="LambdaLogGroupArn") .OutputValue')
export LAMBDA_FUNCTION=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="LifeCycleHookLambdaFunction") .OutputValue')
export ECS_LAMBDA_INVOKE_ROLE=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="EcsLambdaInvokeRoleArn") .OutputValue')
export ECS_CLUSTER_NAME=$(echo $CF_OUTPUT | jq -r '.[] | select(.OutputKey=="ECSClusterName") .OutputValue')

export REGION=$(aws ec2 describe-availability-zones --output text --query 'AvailabilityZones[0].[RegionName]')
export ACCOUNT_ID=$(aws sts get-caller-identity | jq -r .Account)

# Review existing variables
echo "VPC_ID=$VPC_ID"
echo "SUBNET_ID1=$SUBNET_ID1"
echo "SUBNET_ID2=$SUBNET_ID2"
echo "ALB_SG=$ALB_SG"
echo "FRONTEND_SG=$FRONTEND_SG"
echo "BACKEND_SG=$BACKEND_SG"
echo "BLUE_GREEN_TARGET_GROUP=$BLUE_GREEN_TARGET_GROUP"
echo "ALB_ARN=$ALB_ARN"
echo "ALB_DNS=$ALB_DNS"
echo "TASK_EXECUTION_ROLE=$TASK_EXECUTION_ROLE"
echo "TASK_LOG_GROUP_NAME=$TASK_LOG_GROUP_NAME"
echo "LAMBDA_LOG_GROUP_NAME=$LAMBDA_LOG_GROUP_NAME"
echo "LAMBDA_LOG_GROUP_ARN=$LAMBDA_LOG_GROUP_ARN"
echo "LAMBDA_FUNCTION=$LAMBDA_FUNCTION"
echo "ECS_LAMBDA_INVOKE_ROLE=$ECS_LAMBDA_INVOKE_ROLE"
echo "REGION=$REGION"
echo "ACCOUNT_ID=$ACCOUNT_ID"
echo "ECS_CLUSTER_NAME=$ECS_CLUSTER_NAME"

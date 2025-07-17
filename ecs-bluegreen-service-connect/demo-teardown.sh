#!/bin/bash

# Exit on error
set -e

echo "*****************************"
echo "Using AWS Region: $REGION"
echo "*****************************"

# Review existing variables
echo "*****************************"
echo "Review Environment variables"
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
echo "*****************************"

aws ecs delete-service \
    --region $REGION \
    --service bluegreen-backend \
    --cluster $ECS_CLUSTER_NAME \
    --force

aws ecs delete-service \
    --region $REGION \
    --service bluegreen-frontend \
    --cluster $ECS_CLUSTER_NAME \
    --force

# Remove temporary files
rm outputs/taskdef_frontend.json
rm outputs/taskdef_backend.json
rm outputs/taskdef_backend_update.json
rm outputs/service_backend.json
rm outputs/service_frontend.json
rm outputs/service_backend_update.json

#!/bin/bash

# Exit on error
set -e

echo "*****************************"
echo "Using AWS Region: $REGION"
echo "*****************************"

# Review existing variables
echo "*****************************"
echo "Review Environment variables"
echo "*****************************"

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
echo "*****************************"

# Create output directory if it doesn't exist
mkdir -p outputs
echo "Created outputs directory"

# Copy template files
echo "Copying template files..."
cp taskdef_frontend.template.json outputs/taskdef_frontend.json
cp taskdef_backend.template.json outputs/taskdef_backend.json
cp service_frontend.template.json outputs/service_frontend.json
cp service_backend.template.json outputs/service_backend.json
cp service_backend_update.template.json outputs/service_backend_update.json
cp taskdef_backend_update.template.json outputs/taskdef_backend_update.json

echo "Template files copied to outputs directory"

# Detect OS for sed compatibility
echo "Detecting operating system for sed compatibility..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS uses BSD sed which requires an empty string after -i
    echo "macOS detected, using BSD sed syntax"
    SED_CMD="sed -i ''"
else
    # Linux and other systems use GNU sed
    echo "Linux or other OS detected, using GNU sed syntax"
    SED_CMD="sed -i"
fi

# Update task definition with actual values
echo "Updating task definition template..."
bash -c "$SED_CMD 's|TASK_EXECUTION_ROLE|$TASK_EXECUTION_ROLE|g' outputs/taskdef_frontend.json"
bash -c "$SED_CMD 's|TASK_LOG_GROUP_NAME|$TASK_LOG_GROUP_NAME|g' outputs/taskdef_frontend.json"
bash -c "$SED_CMD 's|REGION|$REGION|g' outputs/taskdef_frontend.json"

bash -c "$SED_CMD 's|TASK_EXECUTION_ROLE|$TASK_EXECUTION_ROLE|g' outputs/taskdef_backend.json"
bash -c "$SED_CMD 's|TASK_LOG_GROUP_NAME|$TASK_LOG_GROUP_NAME|g' outputs/taskdef_backend.json"
bash -c "$SED_CMD 's|REGION|$REGION|g' outputs/taskdef_backend.json"

bash -c "$SED_CMD 's|TASK_EXECUTION_ROLE|$TASK_EXECUTION_ROLE|g' outputs/taskdef_backend_update.json"
bash -c "$SED_CMD 's|TASK_LOG_GROUP_NAME|$TASK_LOG_GROUP_NAME|g' outputs/taskdef_backend_update.json"
bash -c "$SED_CMD 's|REGION|$REGION|g' outputs/taskdef_backend_update.json"


# Update service definition with actual values
echo "Updating service template..."
bash -c "$SED_CMD 's|ECS_CLUSTER_NAME|$ECS_CLUSTER_NAME|g' outputs/service_frontend.json"
bash -c "$SED_CMD 's|BLUE_GREEN_TARGET_GROUP|$BLUE_GREEN_TARGET_GROUP|g' outputs/service_frontend.json"
bash -c "$SED_CMD 's|SUBNET_ID1|$SUBNET_ID1|g' outputs/service_frontend.json"
bash -c "$SED_CMD 's|SUBNET_ID2|$SUBNET_ID2|g' outputs/service_frontend.json"
bash -c "$SED_CMD 's|FRONTEND_SG|$FRONTEND_SG|g' outputs/service_frontend.json"

bash -c "$SED_CMD 's|ECS_CLUSTER_NAME|$ECS_CLUSTER_NAME|g' outputs/service_backend.json"
bash -c "$SED_CMD 's|SUBNET_ID1|$SUBNET_ID1|g' outputs/service_backend.json"
bash -c "$SED_CMD 's|SUBNET_ID2|$SUBNET_ID2|g' outputs/service_backend.json"
bash -c "$SED_CMD 's|BACKEND_SG|$BACKEND_SG|g' outputs/service_backend.json"

bash -c "$SED_CMD 's|ECS_CLUSTER_NAME|$ECS_CLUSTER_NAME|g' outputs/service_backend_update.json"
bash -c "$SED_CMD 's|SUBNET_ID1|$SUBNET_ID1|g' outputs/service_backend_update.json"
bash -c "$SED_CMD 's|SUBNET_ID2|$SUBNET_ID2|g' outputs/service_backend_update.json"
bash -c "$SED_CMD 's|BACKEND_SG|$BACKEND_SG|g' outputs/service_backend_update.json"
bash -c "$SED_CMD 's|LAMBDA_FUNCTION|$LAMBDA_FUNCTION|g' outputs/service_backend_update.json"
bash -c "$SED_CMD 's|ECS_LAMBDA_INVOKE_ROLE|$ECS_LAMBDA_INVOKE_ROLE|g' outputs/service_backend_update.json"

echo "Templates have been populated successfully!"

echo "Registering Task Definitions..."
aws ecs register-task-definition \
    --region $REGION \
    --cli-input-json file://outputs/taskdef_frontend.json

aws ecs register-task-definition \
    --region $REGION \
    --cli-input-json file://outputs/taskdef_backend.json

echo "Create Backend Service"
aws ecs create-service \
    --region $REGION \
    --cli-input-json file://outputs/service_backend.json

echo "Wait until the Backend Service is up and running..."
aws ecs wait services-stable \
    --region $REGION \
    --cluster $ECS_CLUSTER_NAME \
    --services bluegreen-backend

echo "Create Frontend Service"
aws ecs create-service \
    --region $REGION \
    --cli-input-json file://outputs/service_frontend.json

echo "Wait until the Frontend Service is up and running..."
aws ecs wait services-stable \
    --region $REGION \
    --cluster $ECS_CLUSTER_NAME \
    --services bluegreen-frontend

echo "You demo environment is ready!"

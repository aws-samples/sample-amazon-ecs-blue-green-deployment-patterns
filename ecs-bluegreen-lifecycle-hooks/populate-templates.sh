#!/bin/bash

# Exit on error
set -e

# Set region (default to eu-west-1 if not provided)
AWS_REGION=${AWS_REGION:-eu-west-1}
echo "Using AWS Region: $AWS_REGION"

# Create output directory if it doesn't exist
mkdir -p outputs
echo "Created outputs directory"

# Copy template files
echo "Copying template files..."
cp taskdef_template.json outputs/taskdef.json
cp service_template.json outputs/service.json
echo "Template files copied to outputs directory"

# Get ECS task execution role ARN
echo "Retrieving ECS task execution role ARN..."
ECS_TASK_EXECUTION_ROLE=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenEcsStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`ECSTaskExecutionRoleArn`].OutputValue' \
    --output text)
echo "ECS Task Execution Role: $ECS_TASK_EXECUTION_ROLE"

# Get ECS log group name
echo "Retrieving ECS log group name..."
ECS_LOG_GROUP_NAME=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenEcsStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`ECSLogGroupName`].OutputValue' \
    --output text)
echo "ECS Log Group Name: $ECS_LOG_GROUP_NAME"

# Get ECS cluster name
echo "Retrieving ECS cluster name..."
ECS_CLUSTER_NAME=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenEcsStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`ECSClusterName`].OutputValue' \
    --output text)
echo "ECS Cluster Name: $ECS_CLUSTER_NAME"

# Get ECS ALB role
echo "Retrieving ECS ALB role ARN..."
ECS_ALB_ROLE=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenEcsStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`ECSAlbRoleArn`].OutputValue' \
    --output text)
echo "ECS ALB Role: $ECS_ALB_ROLE"

# Get ECS Lambda invoke role
echo "Retrieving ECS Lambda invoke role ARN..."
ECS_LAMBDA_ROLE=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenEcsStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`ECSLambdaInvokeRoleArn`].OutputValue' \
    --output text)
echo "ECS Lambda Role: $ECS_LAMBDA_ROLE"

# Get admission hook function ARN
echo "Retrieving admission hook function ARN..."
ADMISSION_HOOK_FUNCTION_ARN=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenHookStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`AdmissionFunction`].OutputValue' \
    --output text)
echo "Admission Hook Function ARN: $ADMISSION_HOOK_FUNCTION_ARN"

# Get approval hook function ARN
echo "Retrieving approval hook function ARN..."
APPROVAL_HOOK_FUNCTION_ARN=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenHookStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`ApprovalFunction`].OutputValue' \
    --output text)
echo "Approval Hook Function ARN: $APPROVAL_HOOK_FUNCTION_ARN"

# Get ALB ARN
echo "Retrieving ALB ARN..."
ALB_ARN=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenNetworkingStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`ALbArn`].OutputValue' \
    --output text)
echo "ALB ARN: $ALB_ARN"

# Get target group ARNs
echo "Retrieving target group ARNs..."
BLUE_TARGET_GROUP_ARN=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenNetworkingStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`BlueTargetGroupArn`].OutputValue' \
    --output text)
echo "Blue Target Group ARN: $BLUE_TARGET_GROUP_ARN"

GREEN_TARGET_GROUP_ARN=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenNetworkingStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`GreenTargetGroupArn`].OutputValue' \
    --output text)
echo "Green Target Group ARN: $GREEN_TARGET_GROUP_ARN"

# Get listener ARNs
echo "Retrieving listener ARNs..."
PROD_LISTENER_ARN=$(aws elbv2 describe-listeners \
    --load-balancer-arn $ALB_ARN \
    --region $AWS_REGION \
    --query 'Listeners[?Port==`80`].ListenerArn | [0]' \
    --output text)
echo "Production Listener ARN: $PROD_LISTENER_ARN"

PROD_LISTENER_RULE_ARN=$(aws elbv2 describe-rules \
    --listener-arn $PROD_LISTENER_ARN \
    --region $AWS_REGION \
    --query Rules[0].RuleArn \
    --output text)
echo "Production Listener Rule ARN: $PROD_LISTENER_RULE_ARN"

TEST_LISTENER_ARN=$(aws elbv2 describe-listeners \
    --load-balancer-arn $ALB_ARN \
    --region $AWS_REGION \
    --query 'Listeners[?Port==`8080`].ListenerArn | [0]' \
    --output text)
echo "Test Listener ARN: $TEST_LISTENER_ARN"

TEST_LISTENER_RULE_ARN=$(aws elbv2 describe-rules \
    --listener-arn $TEST_LISTENER_ARN \
    --region $AWS_REGION \
    --query Rules[0].RuleArn \
    --output text)
echo "Test Listener Rule ARN: $TEST_LISTENER_RULE_ARN"

# Get subnet and security group IDs
echo "Retrieving subnet and security group IDs..."
PRIVATE_SUBNET_ONE=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenNetworkingStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`PrivateSubnet1Id`].OutputValue' \
    --output text)
echo "Private Subnet One: $PRIVATE_SUBNET_ONE"

PRIVATE_SUBNET_TWO=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenNetworkingStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`PrivateSubnet2Id`].OutputValue' \
    --output text)
echo "Private Subnet Two: $PRIVATE_SUBNET_TWO"

TARGET_SECURITY_GROUP=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenNetworkingStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`TargetSecurityGroupId`].OutputValue' \
    --output text)
echo "Target Security Group: $TARGET_SECURITY_GROUP"

# Get S3 Bucket Name
S3_BUCKET_NAME=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenHookStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`ApprovalBucketName`].OutputValue' \
    --output text)
echo "S3 Bucket Name: $S3_BUCKET_NAME"

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
$SED_CMD "s|ECS_TASK_EXECUTION_ROLE|$ECS_TASK_EXECUTION_ROLE|g" outputs/taskdef.json
$SED_CMD "s|ECS_LOG_GROUP_NAME|$ECS_LOG_GROUP_NAME|g" outputs/taskdef.json
$SED_CMD "s|AWS_REGION|$AWS_REGION|g" outputs/taskdef.json

# Update service definition with actual values
echo "Updating service template..."
$SED_CMD "s|ECS_CLUSTER_NAME|$ECS_CLUSTER_NAME|g" outputs/service.json
$SED_CMD "s|ECS_ALB_ROLE|$ECS_ALB_ROLE|g" outputs/service.json
$SED_CMD "s|ECS_LAMBDA_ROLE|$ECS_LAMBDA_ROLE|g" outputs/service.json
$SED_CMD "s|ADMISSION_HOOK_FUNCTION_ARN|$ADMISSION_HOOK_FUNCTION_ARN|g" outputs/service.json
$SED_CMD "s|APPROVAL_HOOK_FUNCTION_ARN|$APPROVAL_HOOK_FUNCTION_ARN|g" outputs/service.json
$SED_CMD "s|BLUE_TARGET_GROUP_ARN|$BLUE_TARGET_GROUP_ARN|g" outputs/service.json
$SED_CMD "s|GREEN_TARGET_GROUP_ARN|$GREEN_TARGET_GROUP_ARN|g" outputs/service.json
$SED_CMD "s|PROD_LISTENER_RULE_ARN|$PROD_LISTENER_RULE_ARN|g" outputs/service.json
$SED_CMD "s|TEST_LISTENER_RULE_ARN|$TEST_LISTENER_RULE_ARN|g" outputs/service.json
$SED_CMD "s|PRIVATE_SUBNET_ONE|$PRIVATE_SUBNET_ONE|g" outputs/service.json
$SED_CMD "s|PRIVATE_SUBNET_TWO|$PRIVATE_SUBNET_TWO|g" outputs/service.json
$SED_CMD "s|TARGET_SECURITY_GROUP|$TARGET_SECURITY_GROUP|g" outputs/service.json
$SED_CMD "s|S3_BUCKET_PLACEHOLDER|$S3_BUCKET_NAME|g" outputs/service.json

echo "Templates have been populated successfully!"
echo ""
echo "To register the task definition, run:"
echo "aws ecs register-task-definition --region $AWS_REGION --cli-input-json file://outputs/taskdef.json"
echo ""
echo "To create the service, run:"
echo "aws ecs create-service --region $AWS_REGION --cluster $ECS_CLUSTER_NAME --cli-input-json file://outputs/service.json"

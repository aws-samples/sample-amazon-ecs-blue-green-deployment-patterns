# Amazon ECS Lifecycle Hooks

This directory contains sample lifecycle hooks for use with Amazon ECS's
built-in [blue/green deployment
controller](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-blue-green.html).
These hooks demonstrate how to implement custom validation, approval workflows,
and advanced traffic shifting patterns during ECS blue/green deployments.

The diagram below shows the various stages within an Amazon ECS blue/green
deployment and the points where lifecycle hooks can be triggered to extend the
deployment process with custom logic.

![ECS Lifecycle Stages](images/lifeyclestages.png "Amazon ECS Lifecycle Stages
and Hooks")

Example lifecycle hooks:

* [Admission Function](./src/admissionFunction/) - This function runs at the
  `PRE_SCALE_UP` stage and validates that container images are from reliable
  sources.
* [Approval Function](./src/approvalFunction/) - This function runs at the
  `POST_TEST_TRAFFIC_SHIFT` stage and provides a manual approval step before
  production traffic is shifted.
* [Canary Function](./src/canaryFunction/) - This function runs at the
  `POST_TEST_TRAFFIC_SHIFT` stage and implements canary traffic shifting. While
  blue/green deployments only support the `allAtOnce` traffic shifting pattern
  by default, this Lambda function enables production traffic to be shifted more
  granularly (by default 20% every 30 seconds, but these values can be
  customized with environment variables).

## End-to-End Walkthrough

This directory contains everything you need to build a demo environment. The
project consists of three CloudFormation stacks:

* [Networking Stack](./lib/ecs-bluegreen-networking-stack.ts) - Provisions an
  Amazon VPC, subnets, security groups, and an Application Load Balancer.
* [ECS Stack](./lib/ecs-bluegreen-ecs-stack.ts) - Provisions an Amazon ECS
  cluster and the relevant IAM roles.
* [Hook Stack](./lib/ecs-bluegreen-hook-stack.ts) - Provisions the sample Lambda
  functions that will be used by the lifecycle hooks.

This project demonstrates how to implement blue/green deployments with Amazon
ECS using AWS CDK. It creates the necessary infrastructure and provides a
complete example for testing and validating deployments.

### Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js and npm installed
- AWS CDK installed (`npm install -g aws-cdk`)
- Docker installed (for building Lambda container images)

### Getting Started

1. Install dependencies:

```bash
npm install
```

2. Build the project:

```bash
npm run build
```

3. Deploy the stacks:

```bash
npx cdk deploy --all
```

Or deploy individual stacks:

```bash
npx cdk deploy EcsBluegreenNetworkingStack
npx cdk deploy EcsBluegreenEcsStack
npx cdk deploy EcsBluegreenHookStack
```

**Customizing Parameters**

You can customize the deployment by providing context parameters:

```bash
npx cdk deploy --all --context yourIpAddress=x.x.x.x/32 --context region=us-east-1
```

Available parameters:

- `yourIpAddress`: Your IP address for ALB security group (format x.x.x.x/32)
- `region`: AWS region to deploy to (default: us-west-2)

#### Populate the Templates

Once the CloudFormation stacks have been deployed, this bash script retrieves
the CloudFormation outputs and populates them into sample Amazon ECS Task
Definition and Service Definition templates. These template files are stored in
the `outputs/` directory.

```bash
./populate-templates.sh
```

You will also need to export a number of environment variables before you can
execute the AWS CLI commands.

```bash
# Set region
AWS_REGION=eu-west-1
ECS_SERVICE_NAME="bluegreendemo"
ECS_CLUSTER_NAME=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenEcsStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`ECSClusterName`].OutputValue' \
    --output text)
```

### Deploy the Sample Application to Amazon ECS

Next, we need to deploy our microservice. To do this, we will first register the
task definition and then create the service.

```bash
# Register task definition
aws ecs \
    register-task-definition \
    --region $AWS_REGION \
    --cli-input-json file://outputs/taskdef.json

# Create the service
aws ecs \
    create-service \
    --region $AWS_REGION \
    --cluster $ECS_CLUSTER_NAME \
    --cli-input-json file://outputs/service.json
```

Wait for the workload to successfully deploy.

```bash
aws ecs \
    wait services-stable \
    --region $AWS_REGION \
    --cluster $ECS_CLUSTER_NAME \
    --service $ECS_SERVICE_NAME
```

### Update Service with New Task Definition

Next, we will trigger a new deployment. We will first deploy a new version of
our task definition with a new color scheme, then update the Amazon ECS service.

```bash
# Update task definition with new color
sed -i "s|orange|green|g" outputs/taskdef.json

# Register the new task definition
aws ecs \
    register-task-definition \
    --region $AWS_REGION \
    --cli-input-json file://outputs/taskdef.json

# Trigger a new deployment
aws ecs \
    update-service \
    --region $AWS_REGION \
    --service $ECS_SERVICE_NAME \
    --cluster $ECS_CLUSTER_NAME \
    --task-definition bluegreendemo
```

### Approval Process

As part of this service deployment, we are using our [Approval
Function](./src/approvalFunction/). This provides a manual gate before shifting
the production traffic. To provide the approval, we need to upload a text file
named after the service revision to Amazon S3.

```bash
# Retrieve the s3 bucket
export S3_BUCKET_NAME=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenHookStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`ApprovalBucketName`].OutputValue' \
    --output text)

# Retrieve the ECS service revision arn
export ECS_SERVICE_REVISION=$(aws ecs \
    --region $AWS_REGION \
    list-service-deployments \
    --service $ECS_SERVICE_NAME \
    --cluster $ECS_CLUSTER_NAME \
    --query 'serviceDeployments[?status==`IN_PROGRESS`].targetServiceRevisionArn' \
    --output text)

# Extract revision ID from ARN
SERVICE_REVISION_ID=$(echo "$ECS_SERVICE_REVISION" | awk -F/ '{print $NF}')

# Create approval file
touch outputs/$SERVICE_REVISION_ID.txt

# Upload to S3
aws s3 cp \
    outputs/$SERVICE_REVISION_ID.txt \
    s3://$S3_BUCKET_NAME/$SERVICE_REVISION_ID.txt
```

### Cleanup

When you're finished, clean up the environment by running these commands:

```bash
aws ecs \
    delete-service \
    --region $AWS_REGION \
    --service $ECS_SERVICE_NAME \
    --cluster $ECS_CLUSTER_NAME \
    --force

# Destroy CDK stacks
npx cdk destroy --all

# Remove temporary files
rm -f outputs/*
```

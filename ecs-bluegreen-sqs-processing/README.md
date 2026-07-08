# Amazon ECS Blue/Green SQS Processing

This directory contains a CDK pattern demonstrating ECS native blue/green
deployments for a **headless service** (no ALB, no service connect) that
processes messages from an SQS queue. It uses SSM Parameter Store to coordinate
which deployment (blue or green) is the active consumer, with lifecycle hook
Lambda functions managing parameter transitions during deployment and rollback.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ECS Blue/Green Deployment                     │
│                                                                     │
│  ┌──────────────┐         ┌──────────────────┐                     │
│  │  Blue Tasks  │──poll──▶│  SSM Parameter   │                     │
│  │  (worker)    │         │  /myapp/.../blue  │                     │
│  └──────┬───────┘         │  = "notactive"   │                     │
│         │                 └──────────────────┘                     │
│         │ (stops consuming)                                         │
│         │                                                           │
│  ┌──────┴───────┐         ┌──────────────────┐     ┌───────────┐  │
│  │ Green Tasks  │──poll──▶│  SSM Parameter   │     │ SQS Queue │  │
│  │  (worker)    │         │  /myapp/.../green │     │           │  │
│  └──────┬───────┘         │  = "active"      │     └─────┬─────┘  │
│         │                 └──────────────────┘           │         │
│         └────────────────── consumes ────────────────────┘         │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │              Lifecycle Hook (Lambda)                         │    │
│  │  PRODUCTION_TRAFFIC_SHIFT → Traffic Shift Lambda            │    │
│  │    Reads productionTrafficWeights from event                │    │
│  │    Sets revision with 100% weight = "active"                │    │
│  │    Sets revision with 0% weight = "notactive"               │    │
│  │    Works for both forward deployment AND rollback           │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## Design Decisions

### Why no Load Balancer?

Headless SQS workers don't serve HTTP traffic. Adding an ALB would add cost and
complexity without benefit. This pattern targets background worker services that
consume from a queue.

### SSM Parameter Store as coordination mechanism

SSM provides a lightweight, low-latency mechanism for signaling active/inactive
state to workers. Each deployment gets its own parameter at
`/myapp/sqs-processing-enabled/<service-revision-id>`. The worker polls this
parameter to determine whether it should consume messages.

### Self-discovery of deployment identity

The deployment ID (service revision ID) is not known at task definition
registration time — it's generated when a deployment starts. The worker
discovers its own identity at startup by:

1. Reading the task ARN from the ECS metadata endpoint v4
2. Calling `DescribeTasks` to get the `startedBy` field (format: `ecs-svc/<revision-id>`)
3. Parsing the service revision ID from `startedBy`

This matches the identifier that lifecycle hooks receive in
`targetServiceRevisionArn`.

### ECS Task Protection

The worker uses the ECS Task Protection API to prevent scale-in events while
actively processing messages. Protection is enabled before processing a batch
and disabled after all messages in the batch are processed and deleted.

### Lifecycle hooks for zero-duplicate consumption

A single Lambda function is registered at `PRODUCTION_TRAFFIC_SHIFT`. This stage
fires during both forward deployments and rollbacks (it's a "recurring
invocation stage" per the ECS docs). The Lambda inspects the
`productionTrafficWeights` in the event payload to determine which revision is
receiving 100% of traffic and sets SSM parameters accordingly. This eliminates
the need for separate activation/rollback functions.

## Project Structure

```
ecs-bluegreen-sqs-processing/
├── bin/ecs-bluegreen.ts                    # CDK app entry point
├── lib/
│   ├── ecs-bluegreen-networking-stack.ts   # VPC, subnets, security group
│   ├── ecs-bluegreen-hook-stack.ts         # SQS queue, Lambda functions
│   └── ecs-bluegreen-ecs-stack.ts          # ECS cluster, task def, service
├── src/
│   ├── trafficShiftFunction/               # PRODUCTION_TRAFFIC_SHIFT hook
│   └── worker/                             # SQS worker application
├── package.json
├── tsconfig.json
└── cdk.json
```

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js and npm installed
- AWS CDK installed (`npm install -g aws-cdk`)
- Docker installed (for building Lambda container images and the worker image)

## Deploy

```bash
npm install
npx cdk deploy --all
```

This deploys all three stacks, builds the Docker images (Lambda and worker),
and creates the ECS service with native blue/green deployment.

## Send Test Messages

```bash
SQS_QUEUE_URL=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenHookStack \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`SqsQueueUrl`].OutputValue' \
    --output text)

# Send a test message
aws sqs send-message \
    --queue-url $SQS_QUEUE_URL \
    --message-body "Hello from blue/green SQS worker!" \
    --region $AWS_REGION

# Send multiple messages
for i in $(seq 1 5); do
    aws sqs send-message \
        --queue-url $SQS_QUEUE_URL \
        --message-body "Test message $i" \
        --region $AWS_REGION
done
```

## Trigger a New Deployment

To trigger a blue/green deployment, update the service with a force flag or a
new task definition:

```bash
CLUSTER_NAME=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenEcsStack \
    --query 'Stacks[0].Outputs[?OutputKey==`ECSClusterName`].OutputValue' \
    --output text)

# Force a new deployment (same task definition)
aws ecs update-service \
    --region $AWS_REGION \
    --service sqs-worker \
    --cluster $CLUSTER_NAME \
    --force-new-deployment
```

During the deployment:
1. Green tasks start and discover their service revision ID
2. Green tasks poll SSM and find their parameter is "notactive" — they wait
3. After production switch, the traffic shift hook sets green to "active" and blue to "notactive"
4. Green tasks begin consuming from SQS
5. Blue tasks finish in-flight messages and stop consuming

## Monitor the Deployment

```bash
# Check deployment status
aws ecs list-service-deployments \
    --service sqs-worker \
    --cluster $CLUSTER_NAME \
    --region $AWS_REGION

# Check SSM parameters
aws ssm get-parameters-by-path \
    --path /myapp/sqs-processing-enabled/ \
    --region $AWS_REGION

# Check worker logs (log group name from CDK output)
aws logs tail /aws/ecs/service/EcsBluegreenEcsStack \
    --region $AWS_REGION \
    --follow
```

## Cleanup

```bash
# Clean up SSM parameters (created by lifecycle hooks, not managed by CDK)
aws ssm get-parameters-by-path --path /myapp/sqs-processing-enabled/ --query 'Parameters[].Name' --output text | \
    xargs -n1 aws ssm delete-parameter --name

# Destroy CDK stacks
npx cdk destroy --all
```

## How It Works

### Deployment Flow

1. **Initial deployment**: ECS creates the service. The traffic shift hook fires
   at `PRODUCTION_TRAFFIC_SHIFT` with the first revision at 100% weight. It sets
   that revision's SSM parameter to "active". The worker discovers its identity,
   reads SSM, and begins consuming.

2. **Update deployment**: A new (green) deployment starts. Green tasks launch,
   discover their identity, read SSM, and find "notactive" — they wait. Blue
   tasks continue consuming normally.

3. **Production switch**: ECS shifts production traffic to green. The traffic
   shift hook fires with green at 100% and blue at 0%. It sets green to "active"
   and blue to "notactive". Green begins consuming; blue finishes in-flight work
   and stops.

4. **Rollback** (if needed): ECS shifts traffic back to blue. The same hook
   fires again with blue at 100% and green at 0%. It sets blue back to "active"
   and green to "notactive". Blue resumes consuming; green stops.

### Worker Self-Discovery

The worker discovers which deployment it belongs to without needing the
deployment ID as an environment variable:

```
ECS Metadata Endpoint v4 → TaskARN, Cluster
DescribeTasks(taskArn) → startedBy = "ecs-svc/<service-revision-id>"
Parse → service-revision-id
SSM path → /myapp/sqs-processing-enabled/<service-revision-id>
```

### Task Protection

While processing messages, the worker enables ECS Task Protection to prevent
the deployment from scaling down the task mid-processing. Protection is released
after all messages in the batch are processed and deleted.

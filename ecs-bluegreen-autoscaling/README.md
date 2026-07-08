# ECS Blue/Green Deployment with Application Auto Scaling

This sample deploys an ECS Fargate service with native blue/green deployment strategy and request-based application auto scaling.

## What it deploys

- **Networking stack**: VPC (3 AZs), ALB with blue/green target groups, security groups
- **ECS stack**: Amazon ECS cluster, task definition, service (3 desired tasks), and auto scaling (3-6 tasks based on request count per target)

The service runs the [AWS Retail Store Sample App](https://gallery.ecr.aws/aws-containers/retail-store-sample-ui) on port 8080 behind an ALB on port 80.

## Prerequisites

- AWS CDK v2 installed (`npm install -g aws-cdk`)
- AWS credentials configured
- Node.js 18+

## Deploy

```bash
npm install
npx cdk bootstrap   # first time only
npx cdk deploy --all
```

To restrict ALB access to your IP:

```bash
# Find your public IP
curl -s https://checkip.amazonaws.com

# Deploy with your IP
npx cdk deploy --all --context region=eu-west-1 --context yourIpAddress=$(curl -s https://checkip.amazonaws.com)/32
```

## Auto Scaling Configuration

| Parameter | Value |
|-----------|-------|
| Min tasks | 3 |
| Max tasks | 6 |
| Target metric | Requests per target (summed across both target groups) |
| Target value | 4000 requests/target/min |
| Scale-in cooldown | 60s |
| Scale-out cooldown | 60s |

See [Why request-based scaling and not CPU](#why-request-based-scaling-and-not-cpu) below for the reasoning behind this choice.

## Load testing

To trigger the auto scaling policy, drive request volume up using [hey](https://github.com/rakyll/hey):

```bash
# Install hey (single binary, no dependencies)
wget -O hey https://storage.googleapis.com/hey-releases/hey_linux_amd64
chmod +x hey

# Get your ALB DNS name from the stack output
ALB_DNS=$(aws cloudformation describe-stacks \
    --stack-name EcsBluegreenNetworkingStack \
    --query 'Stacks[0].Outputs[?OutputKey==`ALBDNSName`].OutputValue' \
    --output text)

# Hit the ALB with 200 concurrent workers for 120 seconds
hey -z 120s -c 200 http://$ALB_DNS/
```

Monitor scaling activity:

```bash
aws application-autoscaling describe-scaling-activities \
    --service-namespace ecs \
    --resource-id service/$(aws cloudformation describe-stacks \
        --stack-name EcsBluegreenEcsStack \
        --query 'Stacks[0].Outputs[?OutputKey==`ECSClusterName`].OutputValue' \
        --output text)/bluegreendemo
```

You should see the task count increase from 3 towards 6 as the per-target request rate crosses the target value. After the load stops and the 60s scale-in cooldown passes, tasks will scale back down.

## Clean up

```bash
npx cdk destroy --all
```

## Why request-based scaling and not CPU

Choosing an autoscaling metric for a native ECS blue/green service is subtle. The obvious choices both have problems, which is why this stack scales on **request count per target, summed across both target groups**.

### Why CPU-based scaling does not work on its own

The intuitive choice is `ECSServiceAverageCPUUtilization` with a target like 50%. It works fine for a rolling-update service, but it breaks for blue/green.

During a blue/green deployment, ECS stands up a **complete green task set alongside the running blue set**. The service-wide CPU metric is averaged across *every* task in the service, blue and green. The moment the green tasks launch you have roughly twice the task count serving the same production load, so the average CPU roughly **halves** even though real per-task load has not changed. A target-tracking policy reads that as "over-provisioned" and wants to scale in mid-deployment. Fortunately, ECS disables scale-in during a blue/green deployment.

CPU utilization cannot be scoped to a single task set or service revision, so there is no way to make the service-wide average reflect only the tasks actually taking production traffic. That rules it out as a standalone signal here.

A workaround for CPU utilization would be to add a monitoring side car container
(e.g. Open Telemetry) which can capture CPU utilization from [Task
Metadata](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-fargate-examples.html#task-metadata-endpoint-v4-fargate-example-task-stats-response),
tag the metric with Revision ID and push to CloudWatch.

### Why request count per target, summed across both target groups

`ALBRequestCountPerTarget` is emitted per target group as *(requests to that target group) / (targets in that target group)*. In a blue/green setup only one target group receives production traffic at a time; the idle group's numerator is 0, so its metric is 0 regardless of how many tasks are registered to it.

That gives a clean trick: **sum the metric across both the blue and green target groups.** The idle group always contributes 0, so the sum always equals the per-target request rate of whichever group is currently live:

```
scaling signal = RequestCountPerTarget(blue) + RequestCountPerTarget(green)
```

- Steady state (blue live): `3000 + 0 = 3000`
- After cutover (green live): `0 + 3000 = 3000`

The signal follows the active target group automatically. We never have to detect which group is active, and there is **no Lambda or lifecycle hook** needed to point the policy at the current group. This is implemented as a `CustomizedMetricSpecification` with inline metric math (`blue + green`) in the ECS stack.

### Caveat: test listeners break the sum

`RequestCountPerTarget` is dimensioned by **TargetGroup + LoadBalancer only** - there is no listener or rule dimension. Every request reaching a target group counts toward its metric, no matter which listener it came in on.

Native ECS blue/green supports a separate **test listener** that routes validation traffic to the alternate (green) target group before you shift production traffic. If you add one, that test traffic is indistinguishable from production in the metric and inflates the sum:

```
blue (production) = 3000
green (test traffic) = 500
sum = 3500   <-- over-reports, biases toward scale-out
```

This worst case is a brief, self-correcting over-scale that unwinds once
the deployment completes - not silent metric corruption.

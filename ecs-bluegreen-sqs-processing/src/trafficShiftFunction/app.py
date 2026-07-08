import boto3
from aws_lambda_powertools import Logger
from botocore.exceptions import ClientError

logger = Logger()

SSM_PARAMETER_PREFIX = "/myapp/sqs-processing-enabled"


def hook_succeeded():
    logger.info("Sending hookStatus SUCCEEDED back to ECS")
    return {"hookStatus": "SUCCEEDED"}


def hook_failed():
    logger.info("Sending hookStatus FAILED back to ECS")
    return {"hookStatus": "FAILED"}


def parse_deployment_id(service_revision_arn):
    """Extract the deployment ID (last segment) from a service revision ARN.

    ARN format: arn:aws:ecs:region:account:service-revision/cluster/service-name/revision-id
    Returns the revision-id portion.
    """
    return service_revision_arn.split("/")[-1]


def lambda_handler(event, context):
    """Handle PRODUCTION_TRAFFIC_SHIFT lifecycle hook.

    This single Lambda handles both forward deployments and rollbacks.
    It inspects the productionTrafficWeights to determine which revision
    is receiving 100% of traffic (becoming active) and sets SSM parameters
    accordingly.

    During forward deployment: green gets 100%, blue gets 0%
    During rollback: blue gets 100%, green gets 0%
    """
    logger.info(event)

    execution_details = event.get("executionDetails", {})
    production_traffic_weights = execution_details.get("productionTrafficWeights", {})

    if not production_traffic_weights:
        logger.info("No productionTrafficWeights in event, nothing to do")
        return hook_succeeded()

    ssm_client = boto3.client("ssm")

    try:
        for revision_arn, weight in production_traffic_weights.items():
            deploy_id = parse_deployment_id(revision_arn)
            param_path = f"{SSM_PARAMETER_PREFIX}/{deploy_id}"

            if weight == 100:
                status = "active"
            else:
                status = "notactive"

            logger.info(
                f"Setting {param_path} to '{status}' (traffic weight: {weight}%)"
            )
            ssm_client.put_parameter(
                Name=param_path,
                Value=status,
                Type="String",
                Overwrite=True,
            )

    except ClientError as e:
        logger.error(f"SSM parameter update failed: {str(e)}")
        return hook_failed()

    logger.info("Traffic shift hook complete — SSM parameters updated")
    return hook_succeeded()

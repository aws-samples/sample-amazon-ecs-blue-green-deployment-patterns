import logging
import os
import signal
import sys
import time

import boto3
import requests
from botocore.exceptions import ClientError
from pythonjsonlogger import jsonlogger

# Configure structured JSON logging
logger = logging.getLogger("sqs-worker")
logger.setLevel(logging.INFO)
handler = logging.StreamHandler(sys.stdout)
formatter = jsonlogger.JsonFormatter(
    fmt="%(asctime)s %(name)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
handler.setFormatter(formatter)
logger.addHandler(handler)

# Environment variables
SQS_QUEUE_URL = os.environ.get("SQS_QUEUE_URL", "")
SSM_POLL_INTERVAL = int(os.environ.get("SSM_POLL_INTERVAL", "10"))
ECS_CLUSTER_NAME = os.environ.get("ECS_CLUSTER_NAME", "")

# SSM parameter prefix
SSM_PARAMETER_PREFIX = "/myapp/sqs-processing-enabled"

# Graceful shutdown flag
shutdown_requested = False


def handle_sigterm(signum, frame):
    """Handle SIGTERM for graceful shutdown."""
    global shutdown_requested
    logger.info("SIGTERM received, initiating graceful shutdown")
    shutdown_requested = True


# Register signal handler
signal.signal(signal.SIGTERM, handle_sigterm)


def discover_deployment_id(ecs_client):
    """Discover the service revision ID for this task at startup.

    Uses the ECS metadata endpoint v4 to get the task ARN, then calls
    DescribeTasks to get the startedBy field which contains the deployment ID
    in the format 'ecs-svc/<service-revision-id>'.

    The service revision ID matches what the lifecycle hooks parse from
    targetServiceRevisionArn.split("/")[-1].
    """
    # Step 1: Get task ARN and cluster from the ECS metadata endpoint v4
    metadata_uri = os.environ.get("ECS_CONTAINER_METADATA_URI_V4", "")
    if not metadata_uri:
        logger.error("ECS_CONTAINER_METADATA_URI_V4 not set - not running in ECS?")
        return None

    try:
        response = requests.get(f"{metadata_uri}/task", timeout=5)
        response.raise_for_status()
        task_metadata = response.json()
    except Exception as e:
        logger.error("Failed to fetch task metadata", extra={"error": str(e)})
        return None

    task_arn = task_metadata.get("TaskARN", "")
    cluster = task_metadata.get("Cluster", "")

    if not task_arn or not cluster:
        logger.error("TaskARN or Cluster not found in metadata response")
        return None

    logger.info(
        "Retrieved task metadata",
        extra={"task_arn": task_arn, "cluster": cluster},
    )

    # Step 2: Call DescribeTasks to get the startedBy field
    try:
        describe_response = ecs_client.describe_tasks(
            cluster=cluster, tasks=[task_arn]
        )
    except ClientError as e:
        logger.error("Failed to describe task", extra={"error": str(e)})
        return None

    tasks = describe_response.get("tasks", [])
    if not tasks:
        logger.error("No tasks returned from DescribeTasks")
        return None

    started_by = tasks[0].get("startedBy", "")
    if not started_by:
        logger.error("startedBy field is empty on task")
        return None

    # Step 3: Parse the service revision ID from startedBy
    # Format is "ecs-svc/<service-revision-id>"
    if "/" in started_by:
        deployment_id = started_by.split("/")[-1]
    else:
        deployment_id = started_by

    logger.info(
        "Discovered deployment identity",
        extra={
            "started_by": started_by,
            "deployment_id": deployment_id,
        },
    )

    return deployment_id


def get_ssm_status(ssm_client, ssm_parameter_path):
    """Read the SSM parameter to determine if this deployment is active.

    Returns "active", "notactive", or "notactive" if parameter does not exist.
    """
    try:
        response = ssm_client.get_parameter(Name=ssm_parameter_path)
        value = response["Parameter"]["Value"]
        return value
    except ClientError as e:
        if e.response["Error"]["Code"] == "ParameterNotFound":
            logger.warning(
                "SSM parameter not found, treating as inactive",
                extra={"parameter_path": ssm_parameter_path},
            )
            return "notactive"
        logger.error(
            "Error reading SSM parameter",
            extra={"error": str(e), "parameter_path": ssm_parameter_path},
        )
        return "notactive"


def enable_task_protection(ecs_client, cluster, task_arn):
    """Enable ECS task protection to prevent scale-in during message processing."""
    try:
        ecs_client.update_task_protection(
            cluster=cluster,
            tasks=[task_arn],
            protectionEnabled=True,
            expiresInMinutes=5,
        )
        logger.info("Task protection enabled", extra={"task_arn": task_arn})
    except ClientError as e:
        logger.warning(
            "Failed to enable task protection",
            extra={"error": str(e), "task_arn": task_arn},
        )


def disable_task_protection(ecs_client, cluster, task_arn):
    """Disable ECS task protection after message processing is complete."""
    try:
        ecs_client.update_task_protection(
            cluster=cluster,
            tasks=[task_arn],
            protectionEnabled=False,
        )
        logger.info("Task protection disabled", extra={"task_arn": task_arn})
    except ClientError as e:
        logger.warning(
            "Failed to disable task protection",
            extra={"error": str(e), "task_arn": task_arn},
        )


def process_message(message):
    """Process a single SQS message.

    This is a placeholder implementation that logs the message body.
    Replace with actual business logic.
    """
    logger.info("Processing message", extra={"message_id": message["MessageId"]})
    # Simulate processing - sleep for 60 seconds to represent work
    time.sleep(60)
    logger.info("Message processed", extra={"message_id": message["MessageId"]})
    return True


def poll_and_process_messages(sqs_client, ecs_client, cluster, task_arn):
    """Poll SQS queue and process messages with task protection."""
    try:
        response = sqs_client.receive_message(
            QueueUrl=SQS_QUEUE_URL,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=5,
        )
    except ClientError as e:
        logger.error("Error receiving SQS messages", extra={"error": str(e)})
        return []

    messages = response.get("Messages", [])
    if not messages:
        logger.info("No messages available in SQS queue")
        return []

    logger.info("Received messages from SQS", extra={"count": len(messages)})

    # Enable task protection before processing
    enable_task_protection(ecs_client, cluster, task_arn)

    for message in messages:
        success = process_message(message)
        if success:
            try:
                sqs_client.delete_message(
                    QueueUrl=SQS_QUEUE_URL,
                    ReceiptHandle=message["ReceiptHandle"],
                )
            except ClientError as e:
                logger.error(
                    "Error deleting message",
                    extra={"message_id": message["MessageId"], "error": str(e)},
                )

    # Disable task protection after processing
    disable_task_protection(ecs_client, cluster, task_arn)

    return messages


def main():
    """Main worker loop."""
    if not SQS_QUEUE_URL:
        logger.error("SQS_QUEUE_URL environment variable is required")
        sys.exit(1)

    ecs_client = boto3.client("ecs")
    ssm_client = boto3.client("ssm")
    sqs_client = boto3.client("sqs")

    # Discover deployment identity at startup
    deployment_id = discover_deployment_id(ecs_client)
    if not deployment_id:
        logger.error("Failed to discover deployment ID, exiting")
        sys.exit(1)

    ssm_parameter_path = f"{SSM_PARAMETER_PREFIX}/{deployment_id}"

    # Get task ARN and cluster for task protection API
    metadata_uri = os.environ.get("ECS_CONTAINER_METADATA_URI_V4", "")
    task_metadata = requests.get(f"{metadata_uri}/task", timeout=5).json()
    task_arn = task_metadata["TaskARN"]
    cluster = task_metadata["Cluster"]

    logger.info(
        "Worker starting",
        extra={
            "deployment_id": deployment_id,
            "sqs_queue_url": SQS_QUEUE_URL,
            "ssm_parameter_path": ssm_parameter_path,
            "ssm_poll_interval": SSM_POLL_INTERVAL,
            "task_arn": task_arn,
            "cluster": cluster,
        },
    )

    previous_status = None

    while not shutdown_requested:
        current_status = get_ssm_status(ssm_client, ssm_parameter_path)

        # Log state transitions
        if current_status != previous_status:
            logger.info(
                "State transition",
                extra={
                    "previous_status": previous_status,
                    "current_status": current_status,
                    "deployment_id": deployment_id,
                },
            )

        if current_status == "active":
            poll_and_process_messages(sqs_client, ecs_client, cluster, task_arn)
        else:
            # When transitioning from active to notactive, in-flight messages
            # have already been processed in the previous iteration's
            # poll_and_process_messages call (which processes all received
            # messages before returning).
            if previous_status == "active":
                logger.info(
                    "Transition from active to inactive complete, "
                    "all in-flight messages processed",
                    extra={"deployment_id": deployment_id},
                )
            time.sleep(SSM_POLL_INTERVAL)

        previous_status = current_status

    logger.info("Graceful shutdown complete", extra={"deployment_id": deployment_id})


if __name__ == "__main__":
    main()

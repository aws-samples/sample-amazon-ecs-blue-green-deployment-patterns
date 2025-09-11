import os

import boto3
from aws_lambda_powertools import Logger
from botocore.exceptions import ClientError

logger = Logger()


def hook_succeeded():
    logger.info("Sending hookStatus SUCCEEDED back to ECS")
    return {"hookStatus": "SUCCEEDED"}


def hook_failed():
    logger.info("Sending hookStatus FAILED back to ECS")
    return {"hookStatus": "FAILED"}


def hook_in_progress():
    logger.info("Sending hookStatus IN_PROGRESS back to ECS")
    return {
        "hookStatus": "IN_PROGRESS",
        "callBackDelay": 30,
        "hookDetails": {"createServiceCheck": True},
    }


def check_service_revision(service_arn):
    # Detect if this is a createService or an updateService. If its a
    # createService then we dont want the manual approval flow.
    ecs_client = boto3.client("ecs")

    logger.info("Retrieving Service Revision List from ECS Service")
    try:
        response = ecs_client.list_service_deployments(service=service_arn)

        no_of_service_revisions = len(response["serviceDeployments"])
        logger.info(
            f"Retrieved {no_of_service_revisions} service revisions for {service_arn}"
        )

        if len(response["serviceDeployments"]) <= 1:
            logger.info(
                "Retrieved a single service Revision, therefore assuming createService"
            )
            return True

        return False

    except ClientError as e:
        logger.error(f"Error retrieving target group ARN: {str(e)}")
        raise e


def check_s3_file(s3_bucket, revision_arn):

    # Extract the revision from the ARN (everything after the last '/')
    revision = revision_arn.split("/")[-1]
    file_name = f"{revision}.txt"

    logger.info(f"Checking if file {file_name} exists in bucket {s3_bucket}")

    # Create S3 client
    s3_client = boto3.client("s3")

    try:
        # Use head_object to check if the file exists
        s3_client.head_object(Bucket=s3_bucket, Key=file_name)
        logger.info(f"File {file_name} exists in bucket {s3_bucket}")
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "404":
            # The file does not exist
            logger.info(f"File {file_name} does not exist in bucket {s3_bucket}")
            return False
        else:
            # Something else went wrong
            logger.error(f"Error checking if file exists: {str(e)}")
            raise e


def lambda_handler(event, context):
    logger.info(event)

    for var in ["serviceArn", "targetServiceRevisionArn"]:
        if var not in event["executionDetails"]:
            error_message = f"Event is missing required {var}"
            logger.error(error_message)
            raise Exception(error_message)

    if "hookDetails" not in event:
        logger.error("No state passed into the function, hookDetails are required")
        return hook_failed()

    if "S3_BUCKET_NAME" not in event["hookDetails"]:
        logger.error("S3_BUCKET_NAME was not passed into the function")
        return hook_failed()
    s3_bucket = event["hookDetails"]["S3_BUCKET_NAME"]

    service_arn = event["executionDetails"]["serviceArn"]
    service_revision = event["executionDetails"]["targetServiceRevisionArn"]

    # if this is a repeat invocation of this hook in this deployment, there is
    # no need to check if this is a new service. We know if its a repeat
    # invocation because we pass state into the hookDetails in every invocation.
    is_first_invocation = True
    if "createServiceCheck" in event["hookDetails"]:
        if event["hookDetails"]["createServiceCheck"]:
            logger.info(
                f"This is not the first invocation of this hook for {service_revision}"
            )
            is_first_invocation = False

    if is_first_invocation:
        # Check if this create service or update service
        is_create_service = check_service_revision(service_arn)
        if is_create_service:
            return hook_succeeded()

    # See if file is in s3
    file_exists = check_s3_file(s3_bucket, service_revision)
    if file_exists:
        return hook_succeeded()

    return hook_in_progress()

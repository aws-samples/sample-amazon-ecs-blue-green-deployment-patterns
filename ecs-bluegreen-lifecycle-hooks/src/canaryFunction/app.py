import os
import time

import boto3
from aws_lambda_powertools import Logger
from botocore.exceptions import ClientError

logger = Logger()

HOOK_STATUS = {
    "SUCCEEDED": "SUCCEEDED",
    "IN_PROGRESS": "IN_PROGRESS",
    "FAILED": "FAILED",
}


def hook_succeeded():
    logger.info("Sending hookStatus SUCCEEDED back to ECS")
    return {"hookStatus": "SUCCEEDED"}


def hook_failed():
    logger.info("Sending hookStatus FAILED back to ECS")
    return {"hookStatus": "FAILED"}


def hook_in_progress():
    logger.info("Sending hookStatus IN_PROGRESS back to ECS")
    callback_delay = int(os.environ.get("CALLBACK_DELAY_SECONDS", "30"))
    return {
        "hookStatus": "IN_PROGRESS",
        "callBackDelay": callback_delay,
    }


def get_listener_arn_from_rule_arn(rule_arn):
    """
    Convert a listener rule ARN to a listener ARN.
    Rule ARN format:    arn:aws:elasticloadbalancing:region:account:listener-rule/app/name/loadbalancerId/listenerId/ruleId
    Listener ARN format: arn:aws:elasticloadbalancing:region:account:listener/app/name/loadbalancerId/listenerId
    """
    return rule_arn.replace("listener-rule/", "listener/").rsplit("/", 1)[0]


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


def get_load_balancer_config(service_revision):
    """
    Retrieve load balancer configuration from service revision.
    Returns tuple of (prod_target_group_arn, prod_listener_rule_arn) or (None, None) if failed.
    """
    ecs_client = boto3.client("ecs")

    logger.info(f"Describing service revision: {service_revision}")
    try:
        service_revisions_response = ecs_client.describe_service_revisions(
            serviceRevisionArns=[service_revision]
        )
        service_revision_detail = service_revisions_response["serviceRevisions"][0]

        # A resolvedConfiguration key, which containers the load balancer
        # configuration, is only available for an active service revision, if
        # for some reason this is not found in this service revision. Fail the
        # deployment.
        if "resolvedConfiguration" not in service_revision_detail:
            logger.info("Resolved Configuration not found")
            logger.info(f"Service Revision:{service_revision_detail}")
            return None, None

        logger.info("Resolved Configuration found")
        load_balancer_config = service_revision_detail["resolvedConfiguration"][
            "loadBalancers"
        ][0]
        prod_target_group_arn = load_balancer_config["targetGroupArn"]
        prod_listener_rule_arn = load_balancer_config["productionListenerRule"]

        return prod_target_group_arn, prod_listener_rule_arn

    except ClientError as e:
        logger.error(f"Error retrieving service revision: {str(e)}")
        return None, None


def get_listener_rule_details(prod_listener_rule_arn):
    """
    Retrieve existing listener rule details.
    Returns the existing rule or None if failed.
    """
    elb_client = boto3.client("elbv2")

    logger.info(f"Describing listener rule: {prod_listener_rule_arn}")
    try:
        rules_response = elb_client.describe_rules(RuleArns=[prod_listener_rule_arn])
        logger.info(f"Existing Rules:{rules_response}")

        existing_rule = rules_response["Rules"][0]
        logger.info(
            f"Existing weights: {existing_rule['Actions'][0]['ForwardConfig']['TargetGroups']}"
        )

        return existing_rule

    except ClientError as e:
        logger.error(f"Error retrieving listener rule: {str(e)}")
        return None


def adjust_target_group_weights(actions, prod_target_group_arn, canary_weight):
    """
    Adjust target group weights for canary deployment.
    Returns True if weights were adjusted, False if production is already at 100%.
    """
    target_groups = actions[0]["ForwardConfig"]["TargetGroups"]

    if target_groups[0]["TargetGroupArn"] == prod_target_group_arn:
        logger.info(
            f"{prod_target_group_arn} is the production target group, current weight is {target_groups[0]['Weight']}"
        )
        # if the production target group is already at 100% return success.
        if target_groups[0]["Weight"] == 100:
            return False

        target_groups[0]["Weight"] = target_groups[0]["Weight"] + canary_weight
        target_groups[1]["Weight"] = target_groups[1]["Weight"] - canary_weight
    else:
        logger.info(
            f"{prod_target_group_arn} is the production target group, current weight is {target_groups[1]['Weight']}"
        )
        # if the production target group is already at 100% return success.
        if target_groups[1]["Weight"] == 100:
            return False

        # TargetGroups[1] is the production target group
        target_groups[0]["Weight"] = target_groups[0]["Weight"] - canary_weight
        target_groups[1]["Weight"] = target_groups[1]["Weight"] + canary_weight

    return True


def modify_listener_weights(prod_listener_rule_arn, actions):
    """
    Modify the listener with new target group weights.
    Returns True if successful, False otherwise.
    """
    elb_client = boto3.client("elbv2")

    listener_arn = get_listener_arn_from_rule_arn(prod_listener_rule_arn)
    logger.info(f"Modifying listener: {listener_arn}")

    # In this sample we only have one rule on our listener, the default rule.
    # In a production environment we would expect there to be multiple rules on
    # the listener so the modify_rules API may be more appropriate.
    try:
        modify_listener_response = elb_client.modify_listener(
            ListenerArn=listener_arn, DefaultActions=actions
        )
        logger.info("Successfully modified listener weights for canary deployment")
        return True

    except ClientError as e:
        logger.error(f"Error modifying listener: {str(e)}")
        return False


def perform_canary_deployment(service_revision):
    """
    Perform the canary deployment by adjusting load balancer weights.
    Returns the appropriate hook status response.
    """
    canary_weight = int(os.environ.get("CANARY_WEIGHT", "20"))

    # Get load balancer configuration
    prod_target_group_arn, prod_listener_rule_arn = get_load_balancer_config(
        service_revision
    )
    if not prod_target_group_arn or not prod_listener_rule_arn:
        return hook_failed()

    # Get existing listener rule details
    existing_rule = get_listener_rule_details(prod_listener_rule_arn)
    if not existing_rule:
        return hook_failed()

    actions = existing_rule["Actions"]

    # Adjust target group weights
    weights_adjusted = adjust_target_group_weights(
        actions, prod_target_group_arn, canary_weight
    )
    if not weights_adjusted:
        return hook_succeeded()

    # Modify listener with new weights
    if not modify_listener_weights(prod_listener_rule_arn, actions):
        return hook_failed()

    return hook_in_progress()


def lambda_handler(event, context):
    logger.info(event)

    for var in ["serviceArn", "targetServiceRevisionArn"]:
        if var not in event["executionDetails"]:
            error_message = f"Event is missing required {var}"
            logger.error(error_message)
            raise Exception(error_message)

    service_arn = event["executionDetails"]["serviceArn"]
    service_revision = event["executionDetails"]["targetServiceRevisionArn"]

    # if there is only one service revision, we dont check for the s3 file.
    # There is an assumption here that manual approval is not required on the
    # first deployment of a service.
    is_create_service = check_service_revision(service_arn)
    if is_create_service:
        return hook_succeeded()

    logger.info("Proceeding with Canary Traffic Switching")
    try:
        return perform_canary_deployment(service_revision)

    except ClientError as e:
        logger.error(f"AWS Client Error: {str(e)}")
        return hook_failed()
    except KeyError as e:
        logger.error(f"Missing required field in event: {str(e)}")
        return hook_failed()
    except Exception as e:
        logger.error(f"Hook failed because: {str(e)}")
        return hook_failed()

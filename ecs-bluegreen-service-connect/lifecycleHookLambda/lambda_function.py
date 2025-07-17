import os

import requests


def lambda_handler(event, context):
    print(event)

    if "ALB_URL" in os.environ and not os.environ["ALB_URL"]:
        raise Exception("Missing Environment Variable - ALB_URL")

    if "MATCHING_HEADER" in os.environ and not os.environ["MATCHING_HEADER"]:
        raise Exception("Missing Environment Variable - MATCHING_HEADER")

    response = requests.get(
        os.environ["ALB_URL"],
        headers={"x-amzn-ecs-bluegreen-test": os.environ["MATCHING_HEADER"]},
        timeout=10,
    )
    response.raise_for_status()
    print(response.text)
    if response.status_code == 200 and "Green Version" in response.text:
        print("SUCCEEDED")
        return {"hookStatus": "SUCCEEDED"}
    else:
        print("FAILED")
        return {"hookStatus": "FAILED"}

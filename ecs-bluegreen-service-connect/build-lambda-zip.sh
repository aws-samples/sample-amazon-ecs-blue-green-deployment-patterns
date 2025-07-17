#!/bin/bash

# Exit on error
set -e

cd lifecycleHookLambda
pip3 install --target ./package requests==2.32.4
cd package && zip -r ../my_deployment_package.zip . && cd ..
zip my_deployment_package.zip lambda_function.py && cd ..
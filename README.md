# Mule infra

This project contains infrastructure for running mule runtime in AWS.

It pulls the docker image from ECR from the gn-build account, and runs it in ECS Fargate.

## Docker image

The repo with the docker image is [here](https://github.com/GemeenteNijmegen/mule-docker-image).

## Manual steps

Every mule AWS account requires the license binaries to be in the secrets manager.

1. To set the license secret:

 aws secretsmanager put-secret-value --secret-id <<arn>> --secret-binary fileb:///path/to/license.lic

2. Navigate to the Parameter Store and set the anypoint env token and server name (from the anypoint manager). This token expires every day and should be refreshed before doing a deploy of a new container.

## Infrastructure

When you push a change to the main branch, the following happens:

### Initial setup & deploy

**Prerequisites**:
- In the build account, the docker image is present in ECR.
- The stack is deployed to AWS (for ssm and secrets manager creation).

**Configuring the anypoint studio token**:
- Navigate to [mulesoft Anypoint Platform eu1](https://eu1.anypoint.mulesoft.com/login/) -> runtime manager
    - Click on "Servers" -> "Add server".
    - Name doesn't matter, the server will register itself with a server name based on the environment name.
    - Copy the anypoint env token and set it in the SSM Parameter Store.
- You can close the popup.

**Initially registering the server**:
- Fargate pulls the image from ECR.
    - The secret is read from AWS Secrets Manager.
    - The anypoint env token is read from AWS SSM Parameter Store.
    - amc_setup is run from the entrypoint.sh script.
        - The file `${MULE_HOME}/conf/mule-agent.yml` is generated. This file is regenerated every deploy. If you need to 
        change the content of this file, change the arguments of amc_setup in the Dockerfile.
- The service is updated.


## Persistant data

Several files should be persistant. Most importantly:
- the license file. This is stored in the secret manager.
- certificates
- applications (otherwise all applications are downloaded and installed every deploy)
- mule application logs (control plane logs are stored in cloudwatch)

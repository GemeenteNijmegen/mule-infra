# Mule infra

This project contains infrastructure for running mule runtime in AWS.

It pulls the docker image from ECR from the gn-build account, and runs it in ECS Fargate.

## Docker image

The repo with the docker image is [here](https://github.com/GemeenteNijmegen/mule-docker-image).

## Manual steps

Every mule AWS account requires the license binaries to be in the secrets manager.

1. To set the license secret:

 aws secretsmanager put-secret-value --secret-id <<arn>> --secret-binary fileb:///path/to/license.lic

2. Configure the required Anypoint Platform credentials. Set the following as SSM Parameters:
   - `ANYPOINT_CLIENT_ID=your_client_id_here`
   - `ANYPOINT_ORG_ID=your_org_id_here`
   - `ANYPOINT_ENV_ID=your_env_id_here`

   Set the following as a Secret in AWS Secrets Manager:
   - `ANYPOINT_CLIENT_SECRET=your_client_secret_here`

## Infrastructure

When you push a change to the main branch, the following happens:

### Initial setup & deploy

**Prerequisites**:
- In the build account, the docker image is present in ECR.
- The stack is deployed to AWS (for ssm and secrets manager creation).

**Registering the server**:
Registration now works with the mule cli and is handled purely in the docker entrypoint. No need for manual steps for server registration.
- Fargate pulls the image from ECR.
    - The `ANYPOINT_CLIENT_SECRET` is read from AWS Secrets Manager.
    - The `ANYPOINT_CLIENT_ID`, `ANYPOINT_ORG_ID`, and `ANYPOINT_ENV_ID` are read from AWS SSM Parameter Store.
    - The server registration is executed automatically using the `anypoint-cli-v4` in the `entrypoint.sh` script.
        - The file `${MULE_HOME}/conf/mule-agent.yml` is generated. This file is regenerated every deploy. If you need to 
        change the content of this file, change the arguments of the amc setup command in the Docker image.
- The service is updated.

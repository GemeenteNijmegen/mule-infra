# Mule infra

This project contains infrastructure for running mule runtime in AWS.

It pulls the docker image from ECR from the gn-build account, and runs it in ECS Fargate.

## Docker image

The repo with the docker image is [here](https://github.com/GemeenteNijmegen/mule-docker-image).

Update the docker image version if there is an update in docker image
 - check line 48 of MuleRuntimeStack (https://github.com/GemeenteNijmegen/mule-infra/blob/development/src/MuleRuntimeStack.ts#L48)

## Manual steps

Every Mule AWS account requires the license binaries, trust/keystore.jks (for Mule), and passwords of trsust/keystore.jks to be stored in the Secrets Manager.

1. Update the value for secrets manager (each environments):
 - license secret, truststore.jks and keystore.jks:

   - `aws secretsmanager put-secret-value --secret-id '<<arn>>' --secret-binary fileb:///path/to/file --region eu-central-1`

 - truststorepassword and keystorepassword:

   - `aws secretsmanager put-secret-value --secret-id '<<arn>>' --secret-string "your_secret" --region eu-central-1`

2. Configure the required Anypoint Platform credentials. Set the following as SSM Parameters:
   - `ANYPOINT_CLIENT_ID=your_client_id_here`
   - `ANYPOINT_ORG_ID=your_org_id_here`
   - `ANYPOINT_ENV_ID=your_env_id_here`

   Set the following as a Secret in AWS Secrets Manager:
   - `ANYPOINT_CLIENT_SECRET=your_client_secret_here`

**Also, every Mule AWS account requires the truststore.pem (for ALB) to be stored in the S3 bucket with public key of certificates. If the .pem is changed, the it has to be replaced with new version. after that the truststore in EC2 has to be replaced with new version.** 

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

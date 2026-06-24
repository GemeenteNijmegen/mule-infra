# Mule infra

This project contains infrastructure for running mule runtime in AWS.

It pulls the docker image from ECR from the gn-build account, and runs it in ECS Fargate.

## Docker image

The repo with the docker image is [here](https://github.com/GemeenteNijmegen/mule-docker-image).

To update the docker image version in `mule-infra`, check `taskDefinition.addContainer` of the `MuleRuntimeStack`.

## Manual Pre-requisites

For each Mule environment (AWS account), you must configure several secrets and parameters manually before deploying the infrastructure.

### 1. Mule License and Keystores (AWS Secrets Manager)

Store the Mule license and keystore files as **binary secrets**. The required secret names are:
*   `/mule-infra/mule/license`
*   `/mule-infra/mule/truststore`
*   `/mule-infra/mule/keystore`

Example command:
```bash
aws secretsmanager put-secret-value --secret-id '<secret-arn>' --secret-binary fileb:///path/to/file --region eu-central-1
```

Store the corresponding passwords as **string secrets**. The required secret names are:
*   `/mule-infra/mule/truststorepassword`
*   `/mule-infra/mule/keystorepassword`

Example command:
```bash
aws secretsmanager put-secret-value --secret-id '<secret-arn>' --secret-string "your_secret" --region eu-central-1
```

### 2. Anypoint Platform Credentials

Set up your Anypoint credentials using both SSM Parameters and AWS Secrets Manager.

**AWS Systems Manager (SSM) Parameters (Type: String):**
*   `/mule-infra/mule/anypoint-client-id`
*   `/mule-infra/mule/anypoint-org-id`
*   `/mule-infra/mule/anypoint-env-id`

> [!TIP]
> We recommend using the AWS Management Console (Systems Manager -> Parameter Store) to create and update these parameters.

**AWS Secrets Manager (Type: String):**
*   `/mule-infra/mule/anypoint-client-security` (This stores the client secret)

Example command:
```bash
aws secretsmanager put-secret-value --secret-id '<secret-arn>' --secret-string "your_client_secret" --region eu-central-1
```

### 3. Application Load Balancer (ALB) Truststore

You must store the `truststore.pem` file containing public certificates in the designated S3 bucket for the ALB. 

> [!WARNING]  
> If the `.pem` file is updated, you must replace it in the S3 bucket and also manually update the truststore on the corresponding EC2 instances to ensure they use the new version.

## Infrastructure

When you push a change to the development, acceptance or main branch, the following happens:

### Initial setup & deploy

**Prerequisites**:
- In the build account, the docker image is present in ECR.
- The stack is deployed to AWS (for ssm and secrets manager creation).
- The manual pre-requisites are done.

**Registering the server**:
Registration now works with the mule cli and is handled purely in the docker entrypoint. No need for manual steps for server registration.
- Fargate pulls the image from ECR.
    - The `ANYPOINT_CLIENT_SECRET` is read from AWS Secrets Manager.
    - The `ANYPOINT_CLIENT_ID`, `ANYPOINT_ORG_ID`, and `ANYPOINT_ENV_ID` are read from AWS SSM Parameter Store.
    - The server registration is executed automatically using the API in the `entrypoint.sh` script during the initial startup.
        - The generated `${MULE_HOME}/conf/mule-agent.yml` file, along with the Mule apps, is stored on an attached EFS volume. This ensures the configuration persists across container restarts and deployments, so the server only needs to be registered once.
- The service is updated.

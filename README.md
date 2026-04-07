# Mule infra

This project contains infrastructure for running mule runtime in AWS.

It pulls the docker image from ECR from the gn-build account, and runs it in ECS Fargate.

The repo with the docker image is [here](https://github.com/GemeenteNijmegen/mule-docker-image).

## Manual steps

1. To set the license secret:

 aws secretsmanager put-secret-value --secret-id <<arn>> --secret-binary fileb:///path/to/license.lic

2. Navigate to the Parameter Store and set the anypoint env token and server name (from the anypoint manager)

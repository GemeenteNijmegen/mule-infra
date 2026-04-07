import { GemeenteNijmegenVpc, PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, Stack, StackProps, aws_ecs as ecs, aws_ec2 as ec2, Duration } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { FargateTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Configurable } from './Configuration';
import { Statics } from './Statics';

interface MuleRuntimeStackProps extends StackProps, Configurable { }

export class MuleRuntimeStack extends Stack {
  constructor(scope: Construct, id: string, private readonly props: MuleRuntimeStackProps) {
    super(scope, id, props);
    Aspects.of(this).add(new PermissionsBoundaryAspect());
    const vpc = new GemeenteNijmegenVpc(this, 'vpc');

    const cluster = new ecs.Cluster(this, 'MuleRuntimeCluster', {
      vpc: vpc.vpc,
    });

    const muleRuntimeEcr = ecr.Repository.fromRepositoryArn(this, 'MuleDockerImageRepository', 'arn:aws:ecr:eu-central-1:836443378780:repository/mule-docker-image');
    const secret = Secret.fromSecretNameV2(this, 'MuleLicenseLic', Statics.secretMuleLicense);

    const taskDefinition: FargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'MuleRuntimeTaskDefinition', {
      cpu: 1024,
      memoryLimitMiB: 8192,
    });
    const container = taskDefinition.addContainer('MuleRuntimeContainer', {
      image: ecs.ContainerImage.fromEcrRepository(muleRuntimeEcr, '8b6f0a64c383b8113dc238572facee90ac534c05'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'mule-runtime' }),
      environment: {
        SECRET_MULE_LICENSE_ARN: secret.secretArn,
      },
      secrets: {
        SERVER_NAME: ecs.Secret.fromSsmParameter(StringParameter.fromStringParameterName(this, 'MuleServerName', Statics.ssmMuleServerName)),
        ANYPOINT_ENV_TOKEN: ecs.Secret.fromSsmParameter(StringParameter.fromStringParameterName(this, 'MuleAnypointEnvToken', Statics.ssmMuleAnypointEnvToken)),
      },
      healthCheck: {
        command: ['CMD-SHELL', '/opt/mule/bin/mule status | grep "Mule Enterprise Edition is running" || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        startPeriod: Duration.seconds(60),
        retries: 3,
      },
    });

    secret.grantRead(taskDefinition.taskRole);

    container.addPortMappings({
      containerPort: 8082,
      protocol: ecs.Protocol.TCP,
    });

    container.addPortMappings({
      containerPort: 8081,
      protocol: ecs.Protocol.TCP,
    });

    new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      minHealthyPercent: 100,
      // add to a subnet with internet access
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // service definieren
    // Image van ECR pullen
  }
}

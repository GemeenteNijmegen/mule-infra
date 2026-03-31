import { GemeenteNijmegenVpc, PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, Stack, StackProps, aws_ecs as ecs, aws_ec2 as ec2 } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { FargateTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';
import { Configurable } from './Configuration';

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

    const taskDefinition: FargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'MuleRuntimeTaskDefinition');
    const container = taskDefinition.addContainer('MuleRuntimeContainer', {
      image: ecs.ContainerImage.fromEcrRepository(muleRuntimeEcr, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'mule-runtime' }),
    });

    container.addPortMappings({
      containerPort: 443,
      protocol: ecs.Protocol.TCP,
    });

    container.addPortMappings({
      containerPort: 8080,
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

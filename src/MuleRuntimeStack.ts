import { GemeenteNijmegenVpc, PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, Stack, StackProps, aws_ecs as ecs, aws_ec2 as ec2, aws_iam as iam, Duration } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { FargateTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
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
      image: ecs.ContainerImage.fromEcrRepository(muleRuntimeEcr, '3b41a83ec903f75f44235c326131dbd9234ce08d'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'mule-runtime' }),
      environment: {
        SECRET_MULE_LICENSE_ARN: secret.secretArn,
        SERVER_NAME: `mule-${props.configuration.branchName}-`,
      },
      secrets: {
        ANYPOINT_ENV_TOKEN: ecs.Secret.fromSsmParameter(StringParameter.fromStringParameterName(this, 'MuleAnypointEnvToken', Statics.ssmMuleAnypointEnvToken)),
      },
    });

    secret.grantRead(taskDefinition.taskRole);

    container.addPortMappings(
      {
        containerPort: 8080,
        protocol: ecs.Protocol.TCP,
      },
      {
        containerPort: 8081,
        protocol: ecs.Protocol.TCP,
      }
    );

    const ecsService = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: props.configuration.taskCount,
      minHealthyPercent: props.configuration.minHealthyPercent,
      maxHealthyPercent: props.configuration.maxHealthyPercent,
      // Disabled so we can configure a maxHealthyPercent of 100 for test.
      // Perhaps we can conditionally enable this for acc/prd.
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.DISABLED,
      // add to a subnet with internet access
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: true,
      healthCheckGracePeriod: Duration.seconds(300),
    });

    // Add SSM permissions to the Task Role
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'],
      }),
    );

    const lb = new ApplicationLoadBalancer(this, 'LB', {
      vpc: vpc.vpc,
      // create a public ip address
      internetFacing: true,
    });

    const listener = lb.addListener('HTTPListener', {
      port: 80,
    });

    listener.addTargets('Target', {
      port: 80,
      targets: [ecsService.loadBalancerTarget({
        containerName: 'MuleRuntimeContainer',
        containerPort: 8080,
      })],
      healthCheck: {
        path: '/health',
        port: '8081',
        healthyHttpCodes: '200',
      },
    });
  }
}

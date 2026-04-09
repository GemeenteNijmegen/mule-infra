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
      image: ecs.ContainerImage.fromEcrRepository(muleRuntimeEcr, '30a16f055bd8b5d039fa94b817230a590b1b10ea'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'mule-runtime' }),
      environment: {
        SECRET_MULE_LICENSE_ARN: secret.secretArn,
      },
      secrets: {
        SERVER_NAME: ecs.Secret.fromSsmParameter(StringParameter.fromStringParameterName(this, 'MuleServerName', Statics.ssmMuleServerName)),
        ANYPOINT_ENV_TOKEN: ecs.Secret.fromSsmParameter(StringParameter.fromStringParameterName(this, 'MuleAnypointEnvToken', Statics.ssmMuleAnypointEnvToken)),
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
      healthCheckGracePeriod: Duration.seconds(120),
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
        containerPort: 8081,
      })],
      healthCheck: {
        path: '/health',
        // This is the login of the web console so a 401 is fine
        healthyHttpCodes: '200,401',
      },
    });
  }
}

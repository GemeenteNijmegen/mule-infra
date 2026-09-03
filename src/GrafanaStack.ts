import * as fs from 'fs';
import * as path from 'path';
import { PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import {
  Aspects,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_servicediscovery as servicediscovery,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
} from 'aws-cdk-lib';
import { ApplicationLoadBalancer, ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Configurable } from './Configuration';
import { Statics } from './Statics';

export interface GrafanaStackProps extends StackProps, Configurable {
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
}

/**
 * Grafana service with a pre-provisioned Loki data source.
 *
 * Grafana is exposed through an HTTP ALB using its AWS-provided DNS name.
 */
export class GrafanaStack extends Stack {
  constructor(scope: Construct, id: string, props: GrafanaStackProps) {
    super(scope, id, props);
    Aspects.of(this).add(new PermissionsBoundaryAspect());

    const logGroup = new logs.LogGroup(this, 'GrafanaLogGroup', {
      logGroupName: `/grafana/${props.configuration.branchName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const adminPassword = new Secret(this, 'GrafanaAdminPassword', {
      secretName: `${Statics.projectName}/grafana/${props.configuration.branchName}/admin-password`,
      description: `Grafana admin password for ${props.configuration.branchName}`,
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const grafanaSg = new ec2.SecurityGroup(this, 'GrafanaSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Grafana ECS task',
      allowAllOutbound: true,
    });
    const albSg = new ec2.SecurityGroup(this, 'GrafanaAlbSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Grafana public HTTP load balancer',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Grafana HTTP access');

    const loadBalancer = new ApplicationLoadBalancer(this, 'GrafanaLoadBalancer', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'GrafanaTaskDefinition', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    const alertTopicName = `${Statics.projectName}-grafana-alerts-${props.configuration.branchName}`;
    const alertTopicArn = `arn:aws:sns:${this.region}:${this.account}:${alertTopicName}`;
    const alertTopic = new sns.Topic(this, 'GrafanaAlertTopic', {
      topicName: alertTopicName,
      displayName: `Mule Grafana alerts ${props.configuration.branchName}`,
    });
    alertTopic.addSubscription(new subscriptions.EmailSubscription('e.kuijs@nijmegen.nl'));
    alertTopic.grantPublish(taskDefinition.taskRole);

    const lokiUrl = this.createLoki(props, grafanaSg);

    const grafanaConfigRoot = path.join(__dirname, 'grafana');
    const renderGrafanaConfig = (contents: string) => contents
      .replace(/__AWS_REGION__/g, this.region)
      .replace(/__SNS_TOPIC_ARN__/g, alertTopicArn)
      .replace(/__LOKI_URL__/g, lokiUrl);
    const dashboard = renderGrafanaConfig(
      fs.readFileSync(path.join(grafanaConfigRoot, 'dashboards/mule-runtime-logs.json'), 'utf8'),
    );
    const provisioningFiles = new Map<string, string>([
      [
        '/var/lib/grafana/provisioning/dashboards/mule.yaml',
        fs.readFileSync(path.join(grafanaConfigRoot, 'provisioning/dashboards/mule.yaml'), 'utf8'),
      ],
      [
        '/var/lib/grafana/provisioning/alerting/mule-runtime-errors.yaml',
        renderGrafanaConfig(
          fs.readFileSync(path.join(grafanaConfigRoot, 'provisioning/alerting/mule-runtime-errors.yaml'), 'utf8'),
        ),
      ],
      [
        '/var/lib/grafana/provisioning/alerting/sns-contact-point.yaml',
        renderGrafanaConfig(
          fs.readFileSync(path.join(grafanaConfigRoot, 'provisioning/alerting/sns-contact-point.yaml'), 'utf8'),
        ),
      ],
      ['/var/lib/grafana/dashboards/mule-runtime-logs.json', dashboard],
      [
        '/var/lib/grafana/provisioning/datasources/loki.yaml',
        renderGrafanaConfig(fs.readFileSync(path.join(grafanaConfigRoot, 'provisioning/datasources/loki.yaml'), 'utf8')),
      ],
    ]);
    const provisioningScript = [
      'set -eu',
      ...Array.from(provisioningFiles.entries()).flatMap(([filePath, contents]) => [
        `mkdir -p '${path.posix.dirname(filePath)}'`,
        `echo '${Buffer.from(contents).toString('base64')}' | base64 -d > '${filePath}'`,
      ]),
      'exec /run.sh grafana server --homepath=/usr/share/grafana --config=/etc/grafana/grafana.ini cfg:default.log.mode=console',
    ].join('\n');
    const container = taskDefinition.addContainer('GrafanaContainer', {
      image: ecs.ContainerImage.fromRegistry(Statics.grafanaDockerImage),
      user: '472',
      entryPoint: ['/bin/sh', '-c'],
      command: [provisioningScript],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'grafana',
        logGroup,
      }),
      environment: {
        GF_PATHS_PROVISIONING: '/var/lib/grafana/provisioning',
        GF_SECURITY_ADMIN_USER: 'admin',
        GF_SERVER_ROOT_URL: `http://${loadBalancer.loadBalancerDnsName}`,
        GF_USERS_ALLOW_SIGN_UP: 'false',
      },
      secrets: {
        GF_SECURITY_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminPassword),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget -q -O - http://localhost:3000/api/health || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
    });
    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });
    const service = new ecs.FargateService(this, 'GrafanaService', {
      cluster: props.cluster,
      taskDefinition,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [grafanaSg],
      healthCheckGracePeriod: Duration.seconds(120),
      enableExecuteCommand: true,
    });
    const httpListener = loadBalancer.addListener('GrafanaHttpListener', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
    });
    httpListener.addTargets('GrafanaTarget', {
      protocol: ApplicationProtocol.HTTP,
      targets: [service.loadBalancerTarget({
        containerName: 'GrafanaContainer',
        containerPort: 3000,
      })],
      healthCheck: {
        path: '/api/health',
        healthyHttpCodes: '200',
      },
    });
    new CfnOutput(this, 'GrafanaUrl', {
      value: `http://${loadBalancer.loadBalancerDnsName}`,
    });
    new CfnOutput(this, 'GrafanaAdminSecretArn', {
      value: adminPassword.secretArn,
    });
    new CfnOutput(this, 'GrafanaAlertTopicArn', {
      value: alertTopic.topicArn,
    });
  }

  /**
   * Single-node Loki on Fargate with an S3 backend, reachable in-VPC at
   * loki.mule-obs.local:3100. Returns the base URL for the Grafana datasource.
   */
  private createLoki(props: GrafanaStackProps, clientSecurityGroup: ec2.SecurityGroup): string {
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'ObservabilityNamespace', {
      name: 'mule-obs.local',
      vpc: props.vpc,
    });

    const bucket = new s3.Bucket(this, 'LokiChunks', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(21) }],
    });

    const securityGroup = new ec2.SecurityGroup(this, 'LokiSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for the Loki ECS task',
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(clientSecurityGroup, ec2.Port.tcp(3100), 'Loki HTTP API');

    // The bucket name is a CloudFormation token that only resolves at deploy
    // time. Substituting it into the config string and then base64-encoding
    // would freeze the unresolved "${Token[...]}" marker into the blob, so Loki
    // would receive that literal string as its bucket name and fail with
    // "InvalidBucketName". Keep the placeholders in the blob and let the
    // container fill them in at start-up from environment variables, whose
    // values CloudFormation does resolve.
    const config = fs.readFileSync(path.join(__dirname, 'grafana/loki/loki-config.yaml'), 'utf8');
    const command = [
      'set -eu',
      'mkdir -p /etc/loki',
      `echo '${Buffer.from(config).toString('base64')}' | base64 -d`
        + ' | sed -e "s|__LOKI_BUCKET__|$LOKI_BUCKET|g" -e "s|__AWS_REGION__|$AWS_REGION|g"'
        + ' > /etc/loki/loki-config.yaml',
      'exec /usr/bin/loki -config.file=/etc/loki/loki-config.yaml',
    ].join('\n');

    const logGroup = new logs.LogGroup(this, 'LokiLogGroup', {
      logGroupName: `/grafana/${props.configuration.branchName}-loki`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'LokiTaskDefinition', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    bucket.grantReadWrite(taskDefinition.taskRole);
    taskDefinition.addContainer('LokiContainer', {
      image: ecs.ContainerImage.fromRegistry(Statics.lokiDockerImage),
      entryPoint: ['/bin/sh', '-c'],
      command: [command],
      environment: {
        LOKI_BUCKET: bucket.bucketName,
        AWS_REGION: this.region,
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'loki', logGroup }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -q -O - http://localhost:3100/ready || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(90),
      },
    }).addPortMappings({ containerPort: 3100, protocol: ecs.Protocol.TCP });

    new ecs.FargateService(this, 'LokiService', {
      cluster: props.cluster,
      taskDefinition,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      cloudMapOptions: { name: 'loki', cloudMapNamespace: namespace },
      enableExecuteCommand: true,
    });

    return `http://loki.${namespace.namespaceName}:3100`;
  }
}

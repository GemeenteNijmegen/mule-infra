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
  aws_efs as efs,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
  aws_servicediscovery as servicediscovery,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
} from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { ApplicationLoadBalancer, ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
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

    const { grafanaOAuthClientId, grafanaOAuthProviderDomain, grafanaOAuthRealm } = props.configuration;
    if (!grafanaOAuthClientId || !grafanaOAuthProviderDomain || !grafanaOAuthRealm) {
      throw new Error(`Grafana OAuth is not configured for ${props.configuration.branchName}`);
    }
    const oauthClientSecret = Secret.fromSecretNameV2(this, 'GrafanaOAuthClientSecret', Statics.secretGrafanaOAuthClientSecret);
    const hostedZone = this.importHostedzone();
    const grafanaUrl = `https://grafana.${hostedZone.zoneName}`;

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

    const dataFileSystem = this.createDataVolume(props, taskDefinition);

    const lokiUrl = this.createLoki(props, grafanaSg);

    const grafanaConfigRoot = path.join(__dirname, 'grafana');
    const renderGrafanaConfig = (contents: string) => contents
      .replace(/__AWS_REGION__/g, this.region)
      .replace(/__SNS_TOPIC_ARN__/g, alertTopicArn)
      .replace(/__LOKI_URL__/g, lokiUrl)
      .replace(/__OAUTH_CLIENT_ID__/g, grafanaOAuthClientId)
      .replace(/__OAUTH_PROVIDER_DOMAIN__/g, grafanaOAuthProviderDomain)
      .replace(/__OAUTH_REALM__/g, grafanaOAuthRealm);
    const dashboards = ['mule-runtime-logs.json', 'erpx.json'].map((fileName): [string, string] => [
      `/var/lib/grafana/dashboards/${fileName}`,
      renderGrafanaConfig(fs.readFileSync(path.join(grafanaConfigRoot, 'dashboards', fileName), 'utf8')),
    ]);
    const provisioningFiles = new Map<string, string>([
      [
        '/var/lib/grafana/conf/grafana.ini',
        renderGrafanaConfig(fs.readFileSync(path.join(grafanaConfigRoot, 'conf/grafana.ini'), 'utf8')),
      ],
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
      ...dashboards,
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
      'exec /run.sh',
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
        // run.sh passes this as --config; arguments appended to run.sh can't override it.
        GF_PATHS_CONFIG: '/var/lib/grafana/conf/grafana.ini',
        GF_PATHS_PROVISIONING: '/var/lib/grafana/provisioning',
        // The SQLite database lives on EFS; everything under
        // /var/lib/grafana is rewritten from this repository at start-up.
        GF_PATHS_DATA: '/grafana-data',
        GF_SECURITY_ADMIN_USER: 'admin',
        // OAuth builds its redirect URI from the root URL.
        GF_SERVER_ROOT_URL: grafanaUrl,
        GF_USERS_ALLOW_SIGN_UP: 'false',
      },
      secrets: {
        GF_SECURITY_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminPassword),
        GF_OAUTH_CLIENT_SECRET: ecs.Secret.fromSecretsManager(oauthClientSecret),
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
    container.addMountPoints({
      containerPath: '/grafana-data',
      readOnly: false,
      sourceVolume: 'grafana-efs-volume',
    });
    const service = new ecs.FargateService(this, 'GrafanaService', {
      cluster: props.cluster,
      taskDefinition,
      desiredCount: 1,
      // SQLite on EFS tolerates one writer. A rolling update would briefly run
      // two tasks against the same database file, and both would evaluate the
      // alert rules and mail the same errors, so the old task is stopped before
      // the new one starts. The 10m query window in the alert rules covers the
      // resulting gap.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.DISABLED,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [grafanaSg],
      healthCheckGracePeriod: Duration.seconds(120),
      enableExecuteCommand: true,
    });
    dataFileSystem.connections.allowDefaultPortFrom(service.connections);
    new CfnOutput(this, 'GrafanaUrl', {
      value: `http://${loadBalancer.loadBalancerDnsName}`,
    });
    new CfnOutput(this, 'GrafanaAdminSecretArn', {
      value: adminPassword.secretArn,
    });
    new CfnOutput(this, 'GrafanaAlertTopicArn', {
      value: alertTopic.topicArn,
    });

    const certificate = new Certificate(this, 'GrafanaCertificate', {
      domainName: `grafana.${hostedZone.zoneName}`,
      validation: CertificateValidation.fromDns(hostedZone),
    });

    const listener = loadBalancer.addListener('HTTPListener', {
      port: 443,
      certificates: [certificate],
    });

    new ARecord(
      this,
      'a-record',
      {
        zone: hostedZone,
        target: RecordTarget.fromAlias(new LoadBalancerTarget(loadBalancer)),
        recordName: 'grafana',
      },
    );

    const loadBalancerTargets = [service.loadBalancerTarget({
      containerName: 'GrafanaContainer',
      containerPort: 3000,
    })];

    listener.addTargets('Target', {
      protocol: ApplicationProtocol.HTTP,
      targets: loadBalancerTargets,
      healthCheck: {
        path: '/api/health',
        healthyHttpCodes: '200',
      },
    });
  }

  /**
   * EFS volume for Grafana's SQLite database, mounted at /grafana-data.
   *
   * Without it the database is lost with the task, taking the alert silences,
   * the notification log that suppresses repeat mails, and any dashboard built
   * in the UI with it. Only the database lives here - the configuration,
   * dashboards and alert rules under /var/lib/grafana are rewritten from this
   * repository on every start, so they stay owned by the IaC.
   *
   * Returns the file system so the service can be allowed to reach it.
   */
  private createDataVolume(props: GrafanaStackProps, taskDefinition: ecs.FargateTaskDefinition): efs.FileSystem {
    const fileSystem = new efs.FileSystem(this, 'GrafanaEfs', {
      vpc: props.vpc,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      outOfInfrequentAccessPolicy: efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
    });
    // 472 is the grafana user in the image; the container runs as it.
    const accessPoint = new efs.AccessPoint(this, 'GrafanaEfsAccessPoint', {
      fileSystem,
      path: '/grafana-data',
      createAcl: {
        ownerUid: '472',
        ownerGid: '472',
        permissions: '755',
      },
      posixUser: {
        uid: '472',
        gid: '472',
      },
    });
    taskDefinition.addVolume({
      name: 'grafana-efs-volume',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });
    taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
      ],
      resources: [fileSystem.fileSystemArn],
      conditions: {
        StringEquals: {
          'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn,
        },
      },
    }));
    return fileSystem;
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
      // Loki plus the Alloy log-shipper sidecar share this task; 1 GiB was tight
      // for both. Bump to 1024 CPU as well if the task shows CPU pressure.
      memoryLimitMiB: 2048,
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

    // Alloy rides in the Loki task as a non-essential sidecar: it pulls the Mule
    // application logs from CloudWatch and pushes them to Loki over
    // localhost. Keeping the reader in-cluster means Grafana never calls an AWS
    // API directly, so a misconfiguration or a growing dataset can't run up an
    // unbounded CloudWatch bill - spend is capped by this container plus Loki's
    // S3 lifecycle expiry.
    const alloyConfig = fs.readFileSync(path.join(__dirname, 'grafana/loki/config.alloy'), 'utf8');
    const alloyCommand = [
      'set -eu',
      `echo '${Buffer.from(alloyConfig).toString('base64')}' | base64 -d > /tmp/config.alloy`,
      // otelcol.receiver.awscloudwatch is an experimental Alloy component, so it
      // only loads with --stability.level=experimental. The image tag is pinned
      // in Statics, so a breaking change can't land until we bump it on purpose.
      'exec alloy run /tmp/config.alloy --stability.level=experimental'
      + ' --disable-reporting --storage.path=/tmp/alloy --server.http.listen-addr=127.0.0.1:12345',
    ].join('\n');
    taskDefinition.addContainer('LokiAlloyContainer', {
      image: ecs.ContainerImage.fromRegistry(Statics.alloyDockerImage),
      // A broken Alloy config or a CloudWatch outage must not take Loki down.
      essential: false,
      entryPoint: ['/bin/sh', '-c'],
      command: [alloyCommand],
      environment: {
        AWS_REGION: this.region,
        // The shared Mule application log group (see MuleRuntimeStack). The
        // per-task runtime groups are deliberately not read.
        MULE_APP_LOG_GROUP: Statics.muleAppLogGroupName(props.configuration.branchName),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'alloy', logGroup }),
    });

    taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'logs:DescribeLogGroups',
        'logs:DescribeLogStreams',
        'logs:FilterLogEvents',
        'logs:GetLogEvents',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:${Statics.muleAppLogGroupName(props.configuration.branchName)}`,
        `arn:aws:logs:${this.region}:${this.account}:log-group:${Statics.muleAppLogGroupName(props.configuration.branchName)}:*`,
      ],
    }));

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

  private importHostedzone() {
    return HostedZone.fromHostedZoneAttributes(this, 'hostedzone', {
      hostedZoneId: StringParameter.valueForStringParameter(
        this,
        Statics.accountHostedzoneId,
      ),
      zoneName: StringParameter.valueForStringParameter(
        this,
        Statics.accountHostedzoneName,
      ),
    });
  }
}


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
  aws_iam as iam,
  aws_logs as logs,
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
 * Test Grafana service with a pre-provisioned CloudWatch data source.
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
    taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'cloudwatch:DescribeAlarms',
        'cloudwatch:GetMetricData',
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:ListMetrics',
        'logs:DescribeLogGroups',
        'logs:DescribeQueries',
        'logs:DescribeLogStreams',
        'logs:FilterLogEvents',
        'logs:GetLogEvents',
        'logs:GetQueryResults',
        'logs:StartQuery',
        'logs:StopQuery',
        'tag:GetResources',
      ],
      resources: ['*'],
    }));
    const grafanaConfigRoot = path.join(__dirname, 'grafana');
    const dashboard = fs.readFileSync(path.join(grafanaConfigRoot, 'dashboards/mule-runtime-logs.json'), 'utf8')
      .replace(/__AWS_ACCOUNT_ID__/g, this.account)
      .replace(/__AWS_REGION__/g, this.region)
      .replace(/__MULE_LOG_GROUP__/g, `/mule/${props.configuration.branchName}/runtime-1`);
    const provisioningFiles = new Map<string, string>([
      [
        '/var/lib/grafana/provisioning/datasources/cloudwatch.yaml',
        fs.readFileSync(path.join(grafanaConfigRoot, 'provisioning/datasources/cloudwatch.yaml'), 'utf8')
          .replace(/__AWS_REGION__/g, this.region),
      ],
      [
        '/var/lib/grafana/provisioning/dashboards/mule.yaml',
        fs.readFileSync(path.join(grafanaConfigRoot, 'provisioning/dashboards/mule.yaml'), 'utf8'),
      ],
      ['/var/lib/grafana/dashboards/mule-runtime-logs.json', dashboard],
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
  }
}

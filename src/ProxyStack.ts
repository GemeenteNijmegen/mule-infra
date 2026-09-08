import { PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, Stack, StackProps, aws_ecs as ecs, aws_ec2 as ec2, aws_iam as iam } from 'aws-cdk-lib';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Configurable } from './Configuration';
import { Statics } from './Statics';

export interface ProxyStackProps extends StackProps, Configurable {
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  /**
   * The ActiveMQ broker security group. The proxy is granted egress to its web
   * console port so developers can reach the console through the SSM tunnel.
   */
  readonly messageQueueSecurityGroup: ec2.ISecurityGroup;
}

/**
 * Stack creating an on-demand tinyproxy Fargate task definition.
 *
 * No ECS Service is created — developers launch tasks on-demand via:
 *   ./scripts/start-proxy.sh
 *
 * SSM port-forwarding tunnels port 8888 from the laptop into the VPC.
 */
export class ProxyStack extends Stack {
  constructor(scope: Construct, id: string, props: ProxyStackProps) {
    super(scope, id, props);
    Aspects.of(this).add(new PermissionsBoundaryAspect());

    // Dedicated security group: no inbound needed (SSM tunnels via outbound HTTPS).
    const proxySg = new ec2.SecurityGroup(this, 'ProxySecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for on-demand tinyproxy ECS task',
      allowAllOutbound: true,
    });

    // Let the proxy reach the Amazon MQ web console (port 8162) on the broker
    // instances. Attached from the proxy side with allowTo() so the cross-stack
    // security-group reference resolves as ProxyStack -> MuleRuntimeStack,
    // matching the existing dependency direction (vpc/cluster) rather than
    // creating a cyclic one.
    proxySg.connections.allowTo(
      props.messageQueueSecurityGroup,
      ec2.Port.tcp(Statics.activeMqConsolePort),
      'ActiveMQ web console via on-demand proxy',
    );

    const proxyTaskDefinition = new ecs.FargateTaskDefinition(this, 'ProxyTaskDefinition', {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    // Write a minimal tinyproxy config and start the proxy.
    // Allowing all sources is safe: access is gated by the SSM session.
    // ConnectPort limits the CONNECT (HTTPS tunnelling) method: 443 for normal
    // TLS sites and 8162 for the Amazon MQ web console. Once any ConnectPort is
    // listed the method is deny-by-default, so 443 must stay in the list.
    proxyTaskDefinition.addContainer('TinyproxyContainer', {
      image: ecs.ContainerImage.fromRegistry('vimagick/tinyproxy'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'tinyproxy' }),
      command: [
        'sh', '-c',
        [
          `printf 'Port ${Statics.proxyContainerPort}\\nListen 0.0.0.0\\nTimeout 600\\nMaxClients 20\\nAllow 0.0.0.0/0\\nConnectPort 443\\nConnectPort ${Statics.activeMqConsolePort}\\nLogLevel Critical\\n'`,
          '> /etc/tinyproxy/tinyproxy.conf',
          '&& tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf',
        ].join(' '),
      ],
      portMappings: [{
        containerPort: Statics.proxyContainerPort,
        protocol: ecs.Protocol.TCP,
      }],
    });

    // Grant SSM execute-command permissions so port-forwarding works.
    proxyTaskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    // Pick the first private egress subnet to publish for the start-proxy script.
    const privateSubnets = props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });

    // Publish discovery parameters so start-proxy.sh needs no hard-coded values.
    new StringParameter(this, 'ProxyClusterName', {
      parameterName: Statics.ssmProxyClusterName,
      stringValue: props.cluster.clusterName,
      description: 'ECS cluster name for on-demand tinyproxy task',
    });

    new StringParameter(this, 'ProxyTaskDefinitionArn', {
      parameterName: Statics.ssmProxyTaskDefinitionArn,
      stringValue: proxyTaskDefinition.taskDefinitionArn,
      description: 'Fargate task definition ARN for on-demand tinyproxy task',
    });

    new StringParameter(this, 'ProxySubnetId', {
      parameterName: Statics.ssmProxySubnetId,
      stringValue: privateSubnets.subnetIds[0],
      description: 'Subnet ID for launching the tinyproxy task',
    });

    new StringParameter(this, 'ProxySecurityGroupId', {
      parameterName: Statics.ssmProxySecurityGroupId,
      stringValue: proxySg.securityGroupId,
      description: 'Security group ID for the tinyproxy task',
    });
  }
}

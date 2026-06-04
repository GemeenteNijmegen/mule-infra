import { GemeenteNijmegenVpc, PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, Duration, Stack, StackProps, aws_ec2 as ec2, aws_ecs as ecs } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { FargateTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancer, ApplicationProtocol, MutualAuthenticationMode, TrustStore } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { CfnResolverEndpoint, CfnResolverRule, CfnResolverRuleAssociation } from 'aws-cdk-lib/aws-route53resolver';
import { Bucket } from 'aws-cdk-lib/aws-s3';
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

    const hostedZone = this.importHostedzone();
    const certificate = new Certificate(this, 'certificate', {
      domainName: '*.' + hostedZone.zoneName,
      validation: CertificateValidation.fromDns(hostedZone),
    });


    // Make karelstad.nl resolve in this VPC
    this.onPremDnsRouting(vpc.vpc);

    const cluster = new ecs.Cluster(this, 'MuleRuntimeCluster', {
      vpc: vpc.vpc,
    });

    const muleRuntimeEcr = ecr.Repository.fromRepositoryArn(this, 'MuleDockerImageRepository', 'arn:aws:ecr:eu-central-1:836443378780:repository/mule-docker-image');
    const licenseSecret = Secret.fromSecretNameV2(this, 'MuleLicenseLic', Statics.secretMuleLicense);
    const clientSecret = Secret.fromSecretNameV2(this, 'MuleAnypointClientSecret', Statics.secretMuleAnypointClientSecret);
    const trustStore = Secret.fromSecretNameV2(this, 'MuleTrustStore', Statics.secretMuleTrustStore);
    const keyStore = Secret.fromSecretNameV2(this, 'MuleKeyStore', Statics.secretMuleKeyStore);
    const keystorePassword = Secret.fromSecretNameV2(this, 'MuleKeystorePassword', Statics.secretMuleKeystorePassword);
    const truststorePassword = Secret.fromSecretNameV2(this, 'MuleTruststorePassword', Statics.secretMuleTruststorePassword);

    const taskDefinition: FargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'MuleRuntimeTaskDefinition', {
      cpu: 1024,
      memoryLimitMiB: 8192,
    });
    const container = taskDefinition.addContainer('MuleRuntimeContainer', {
      image: ecs.ContainerImage.fromEcrRepository(muleRuntimeEcr, 'bcaa1e168c9b1b3e6931e1857e53bf7c2156e788'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'mule-runtime' }),
      environment: {
        SECRET_MULE_LICENSE_ARN: licenseSecret.secretArn,
        SERVER_NAME: `mule-${props.configuration.branchName}`,
        MULE_TRUSTSTORE: trustStore.secretArn,
        MULE_KEYSTORE: keyStore.secretArn,
      },
      secrets: {
        ANYPOINT_CLIENT_ID: ecs.Secret.fromSsmParameter(StringParameter.fromStringParameterName(this, 'MuleAnypointClientId', Statics.ssmMuleAnypointClientId)),
        ANYPOINT_CLIENT_SECRET: ecs.Secret.fromSecretsManager(clientSecret),
        ANYPOINT_ORG_ID: ecs.Secret.fromSsmParameter(StringParameter.fromStringParameterName(this, 'MuleAnypointOrgId', Statics.ssmMuleAnypointOrgId)),
        ANYPOINT_ENV_ID: ecs.Secret.fromSsmParameter(StringParameter.fromStringParameterName(this, 'MuleAnypointEnvId', Statics.ssmMuleAnypointEnvId)),
        MULE_KEYSTORE_PASSWORD: ecs.Secret.fromSecretsManager(keystorePassword),
        MULE_TRUSTSTORE_PASSWORD: ecs.Secret.fromSecretsManager(truststorePassword),
      },
    });

    licenseSecret.grantRead(taskDefinition.taskRole);
    trustStore.grantRead(taskDefinition.taskRole);
    keyStore.grantRead(taskDefinition.taskRole);
    clientSecret.grantRead(taskDefinition.obtainExecutionRole());
    truststorePassword.grantRead(taskDefinition.obtainExecutionRole());
    keystorePassword.grantRead(taskDefinition.obtainExecutionRole());

    container.addPortMappings(
      {
        containerPort: 8081,
        protocol: ecs.Protocol.TCP,
      },
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
      healthCheckGracePeriod: Duration.seconds(300),
    });

    const lb = new ApplicationLoadBalancer(this, 'LB', {
      vpc: vpc.vpc,
      internetFacing: true,
    });

    const listener = lb.addListener('HTTPListener', {
      port: 443,
      certificates: [certificate],
      mutualAuthentication: {
        mutualAuthenticationMode: MutualAuthenticationMode.VERIFY,
        trustStore: new TrustStore(this, 'trustStore', {
          bucket: Bucket.fromBucketName(this, 'trustStoreBucket', StringParameter.valueForStringParameter(this, Statics.ssmALBtruststore)),
          key: 'truststore.pem',
        }),
      },
    });

    new ARecord(
      this,
      'a-record',
      {
        zone: hostedZone,
        target: RecordTarget.fromAlias(new LoadBalancerTarget(lb)),
        recordName: '*',
      },
    );

    listener.addTargets('Target', {
      protocol: ApplicationProtocol.HTTP,
      targets: [ecsService.loadBalancerTarget({
        containerName: 'MuleRuntimeContainer',
        containerPort: 8081,
      })],
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        healthyThresholdCount: 2,
      },
    });
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

  private onPremDnsRouting(vpc: IVpc) {

    const outboundSg = new ec2.SecurityGroup(this, 'OutboundResolverSg', {
      vpc,
      description: 'Route53 Resolver outbound endpoint',
    });
    outboundSg.addEgressRule(
      ec2.Peer.ipv4('10.16.0.10/32'),
      ec2.Port.udp(53),
    );
    outboundSg.addEgressRule(
      ec2.Peer.ipv4('10.16.0.20/32'),
      ec2.Port.udp(53),
    );

    // Outbound endpoint - one ENI per AZ
    const outboundEndpoint = new CfnResolverEndpoint(this, 'OutboundEndpoint', {
      direction: 'OUTBOUND',
      securityGroupIds: [outboundSg.securityGroupId],
      ipAddresses: [
        { subnetId: vpc.privateSubnets[0].subnetId },
        { subnetId: vpc.privateSubnets[1].subnetId },
      ],
    });

    // Forwarding rule - send karelstad.nl queries to on-prem DNS
    const forwardingRule = new CfnResolverRule(this, 'ForwardIrvnRule', {
      domainName: 'karelstad.nl',
      ruleType: 'FORWARD',
      resolverEndpointId: outboundEndpoint.attrResolverEndpointId,
      targetIps: [
        { ip: '10.16.0.10', port: '53' },
        { ip: '10.16.0.20', port: '53' },
      ],
    });

    // Associate the rule with the VPC
    new CfnResolverRuleAssociation(this, 'ForwardIrvnRuleAssoc', {
      resolverRuleId: forwardingRule.attrResolverRuleId,
      vpcId: vpc.vpcId,
    });
  }
}

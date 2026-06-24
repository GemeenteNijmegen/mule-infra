import { GemeenteNijmegenVpc, PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, Stack, StackProps, aws_ecs as ecs, aws_ec2 as ec2, aws_efs as efs, aws_iam as iam, Duration } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { FargateTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancer, ApplicationProtocol, MutualAuthenticationMode, TrustStore } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
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

    const fileSystem = new efs.FileSystem(this, 'MuleEfs', {
      vpc: vpc.vpc,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      outOfInfrequentAccessPolicy: efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
    });

    const hostedZone = this.importHostedzone();
    const certificate = new Certificate(this, 'certificate', {
      domainName: '*.' + hostedZone.zoneName,
      validation: CertificateValidation.fromDns(hostedZone),
    });

    const cluster = new ecs.Cluster(this, 'MuleRuntimeCluster', {
      vpc: vpc.vpc,
    });

    const muleRuntimeEcr = ecr.Repository.fromRepositoryArn(this, 'MuleDockerImageRepository', Statics.muleDockerImageRepositoryArn);
    const licenseSecret = Secret.fromSecretNameV2(this, 'MuleLicenseLic', Statics.secretMuleLicense);
    const clientSecret = Secret.fromSecretNameV2(this, 'MuleAnypointClientSecret', Statics.secretMuleAnypointClientSecret);
    const trustStore = Secret.fromSecretNameV2(this, 'MuleTrustStore', Statics.secretMuleTrustStore);
    const keyStore = Secret.fromSecretNameV2(this, 'MuleKeyStore', Statics.secretMuleKeyStore);
    const keystorePassword = Secret.fromSecretNameV2(this, 'MuleKeystorePassword', Statics.secretMuleKeystorePassword);
    const truststorePassword = Secret.fromSecretNameV2(this, 'MuleTruststorePassword', Statics.secretMuleTruststorePassword);

    const clientIdParam = StringParameter.fromStringParameterName(this, 'MuleAnypointClientId', Statics.ssmMuleAnypointClientId);
    const orgIdParam = StringParameter.fromStringParameterName(this, 'MuleAnypointOrgId', Statics.ssmMuleAnypointOrgId);
    const envIdParam = StringParameter.fromStringParameterName(this, 'MuleAnypointEnvId', Statics.ssmMuleAnypointEnvId);

    const loadBalancerTargets = [];
    let previousService: ecs.FargateService | undefined;

    // We iterate based on the taskCount defined in the configuration to create individual ECS services.
    // If taskCount is 0 (e.g. in development), we still iterate at least once to ensure the
    // FargateService is provisioned in AWS. Its desiredCount will be set to 0, allowing it to
    // be scaled up manually via the AWS Console when needed.
    // This per-service approach allows us to assign a predictable, incremental server name and
    // dedicated EFS path (e.g., mule-acceptance-1, mule-acceptance-2) to each container.
    // A stable EFS mount is crucial because it persists installed applications and the mule-agent.yml file across container restarts.
    // Preserving the mule-agent.yml is required to maintain the server's registration and connectivity with Anypoint Runtime Manager.
    const loopCount = Math.max(1, props.configuration.taskCount);
    for (let i = 1; i <= loopCount; i++) {
      const accessPoint = new efs.AccessPoint(this, `MuleEfsAccessPoint${i}`, {
        fileSystem,
        path: `/mule-data-${i}`,
        createAcl: {
          ownerUid: '1000',
          ownerGid: '1000',
          permissions: '755',
        },
        posixUser: {
          uid: '1000',
          gid: '1000',
        },
      });

      const taskDefinition: FargateTaskDefinition = new ecs.FargateTaskDefinition(this, `MuleRuntimeTaskDefinition${i}`, {
        cpu: props.configuration.cpu,
        memoryLimitMiB: props.configuration.memoryLimitMiB,
      });

      taskDefinition.addVolume({
        name: 'mule-efs-volume',
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
          'elasticfilesystem:ClientRootAccess',
        ],
        resources: [fileSystem.fileSystemArn],
        conditions: {
          StringEquals: {
            'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn,
          },
        },
      }));

      const container = taskDefinition.addContainer('MuleRuntimeContainer', {
        image: ecs.ContainerImage.fromEcrRepository(muleRuntimeEcr, 'de1b2ea256fc71899efecff4b500d003b39d2e73'),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: `mule-runtime-${i}` }),
        environment: {
          SECRET_MULE_LICENSE_ARN: licenseSecret.secretArn,
          SERVER_NAME: `mule-${props.configuration.branchName.toLowerCase()}-${i}`,
          MULE_TRUSTSTORE: trustStore.secretArn,
          MULE_KEYSTORE: keyStore.secretArn,
        },
        secrets: {
          ANYPOINT_CLIENT_ID: ecs.Secret.fromSsmParameter(clientIdParam),
          ANYPOINT_CLIENT_SECRET: ecs.Secret.fromSecretsManager(clientSecret),
          ANYPOINT_ORG_ID: ecs.Secret.fromSsmParameter(orgIdParam),
          ANYPOINT_ENV_ID: ecs.Secret.fromSsmParameter(envIdParam),
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

      container.addMountPoints({
        containerPath: '/efs-data',
        readOnly: false,
        sourceVolume: 'mule-efs-volume',
      });

      const ecsService = new ecs.FargateService(this, `Service${i}`, {
        cluster,
        taskDefinition,
        desiredCount: props.configuration.taskCount === 0 ? 0 : 1,
        minHealthyPercent: props.configuration.minHealthyPercent,
        maxHealthyPercent: props.configuration.maxHealthyPercent,
        // Disabled so we can configure a maxHealthyPercent of 100 for test.
        // Perhaps we can conditionally enable this for acc/prd.
        availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.DISABLED,
        // add to a subnet with internet access
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        healthCheckGracePeriod: Duration.seconds(300),
        enableExecuteCommand: true,
      });

      if (previousService) {
        ecsService.node.addDependency(previousService);
      }
      previousService = ecsService;

      // Allow the ECS service to connect to the EFS file system
      fileSystem.connections.allowDefaultPortFrom(ecsService.connections);

      loadBalancerTargets.push(ecsService.loadBalancerTarget({
        containerName: 'MuleRuntimeContainer',
        containerPort: 8081,
      }));
    }

    const lb = new ApplicationLoadBalancer(this, 'LB', {
      vpc: vpc.vpc,
      internetFacing: true,
    });

    const listener = lb.addListener('HTTPListener', {
      port: 443,
      certificates: [certificate],
      mutualAuthentication: {
        mutualAuthenticationMode: MutualAuthenticationMode.VERIFY,
        trustStore: new TrustStore(this, 'trustStore-ec2', {
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
      targets: loadBalancerTargets,
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
}

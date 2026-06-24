import { PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, Stack, Stage, StageProps, Tags } from 'aws-cdk-lib';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Configurable } from './Configuration';
import { Statics } from './Statics';

export interface ParameterStageProps extends StageProps, Configurable { }

/**
 * Stage for creating SSM parameters. This needs to run
 * before stages that use them.
 */
export class ParameterStage extends Stage {
  constructor(scope: Construct, id: string, props: ParameterStageProps) {
    super(scope, id, props);
    Tags.of(this).add('cdkManaged', 'yes');
    Tags.of(this).add('Project', Statics.projectName);
    Aspects.of(this).add(new PermissionsBoundaryAspect());
    new ParameterStack(this, 'stack');
  }
}

/**
 * Stack that creates ssm parameters for the application.
 * These need to be present before stacks that use them.
 */
export class ParameterStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    Tags.of(this).add('cdkManaged', 'yes');
    Tags.of(this).add('Project', Statics.projectName);

    new StringParameter(this, 'mule-anypoint-client-id', {
      stringValue: '-',
      parameterName: Statics.ssmMuleAnypointClientId,
    });

    new Secret(this, 'mule-anypoint-client-secret', {
      secretName: Statics.secretMuleAnypointClientSecret,
    });

    new StringParameter(this, 'mule-anypoint-org-id', {
      stringValue: '-',
      parameterName: Statics.ssmMuleAnypointOrgId,
    });

    new StringParameter(this, 'mule-anypoint-env-id', {
      stringValue: '-',
      parameterName: Statics.ssmMuleAnypointEnvId,
    });

    new Secret(this, 'mule-license', {
      secretName: Statics.secretMuleLicense,
    });

    const trustStoreBucket = new Bucket(this, 'trustStoreBucket', {
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      versioned: true,
    });

    new StringParameter(this, 'ALB-truststore', {
      stringValue: trustStoreBucket.bucketName,
      parameterName: Statics.ssmALBtruststore,
    });

    new Secret(this, 'mule-truststore', {
      secretName: Statics.secretMuleTrustStore,
    });

    new Secret(this, 'mule-keystore', {
      secretName: Statics.secretMuleKeyStore,
    });

    new Secret(this, 'mule-truststore-password', {
      secretName: Statics.secretMuleTruststorePassword,
    });

    new Secret(this, 'mule-keystore-password', {
      secretName: Statics.secretMuleKeystorePassword,
    });

  }
}
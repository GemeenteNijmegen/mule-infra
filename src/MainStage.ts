import { PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, Stage, StageProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Configurable } from './Configuration';
import { MuleRuntimeStack } from './MuleRuntimeStack';

interface MainStageProps extends StageProps, Configurable { }

/**
 * Main cdk app stage
 */
export class MainStage extends Stage {

  constructor(scope: Construct, id: string, props: MainStageProps) {
    super(scope, id, props);
    Aspects.of(this).add(new PermissionsBoundaryAspect());

    /**
     * Main stack of this project
     */
    new MuleRuntimeStack(this, 'stack', {
      env: props.configuration.deploymentEnvironment,
      configuration: props.configuration,
    });

  }

}
import { PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, Stage, StageProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Configurable } from './Configuration';
import { GrafanaStack } from './GrafanaStack';
import { MuleRuntimeStack } from './MuleRuntimeStack';
import { ProxyStack } from './ProxyStack';

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
    const muleStack = new MuleRuntimeStack(this, 'stack', {
      env: props.configuration.deploymentEnvironment,
      configuration: props.configuration,
    });

    /**
     * On-demand proxy stack for dev/acc environments
     */
    if (props.configuration.proxyEnabled) {
      new ProxyStack(this, 'proxy-stack', {
        env: props.configuration.deploymentEnvironment,
        configuration: props.configuration,
        vpc: muleStack.vpc,
        cluster: muleStack.cluster,
      });
    }

    new GrafanaStack(this, 'grafana-stack', {
      env: props.configuration.deploymentEnvironment,
      configuration: props.configuration,
      vpc: muleStack.vpc,
      cluster: muleStack.cluster,
    });

  }

}

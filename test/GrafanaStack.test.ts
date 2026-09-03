import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Configuration } from '../src/Configuration';
import { GrafanaStack } from '../src/GrafanaStack';
import { MuleRuntimeStack } from '../src/MuleRuntimeStack';

describe('GrafanaStack', () => {
  const defaultProps = {
    env: { account: '123456789012', region: 'eu-central-1' },
    configuration: {
      branchName: 'development',
      buildEnvironment: { account: '123456789012', region: 'eu-central-1' },
      deploymentEnvironment: { account: '123456789012', region: 'eu-central-1' },
      taskCount: 1,
      cpu: 2048,
      memoryLimitMiB: 16384,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      proxyEnabled: true,
    } as unknown as Configuration,
  };

  test('provisions Grafana alerting files', () => {
    const app = new App();
    const muleStack = new MuleRuntimeStack(app, 'MuleRuntimeStack', {
      ...defaultProps,
    });
    const grafanaStack = new GrafanaStack(app, 'GrafanaStack', {
      ...defaultProps,
      vpc: muleStack.vpc,
      cluster: muleStack.cluster,
    });

    const template = Template.fromStack(grafanaStack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Command: Match.arrayWith([
            Match.stringLikeRegexp('/var/lib/grafana/provisioning/alerting/mule-runtime-errors.yaml'),
          ]),
        }),
      ]),
    });

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Command: Match.arrayWith([
            Match.stringLikeRegexp('/var/lib/grafana/provisioning/alerting/sns-contact-point.yaml'),
          ]),
        }),
      ]),
    });

    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'e.kuijs@nijmegen.nl',
    });
  });

  test('deploys Loki and provisions it as the default Grafana datasource', () => {
    const app = new App();
    const muleStack = new MuleRuntimeStack(app, 'MuleRuntimeStack', { ...defaultProps });
    const grafanaStack = new GrafanaStack(app, 'GrafanaStack', {
      ...defaultProps,
      vpc: muleStack.vpc,
      cluster: muleStack.cluster,
    });

    const template = Template.fromStack(grafanaStack);

    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::ServiceDiscovery::PrivateDnsNamespace', 1);
    const taskDefinition = template.findResources('AWS::ECS::TaskDefinition');
    const commandText = JSON.stringify(taskDefinition);

    expect(commandText).toContain('/var/lib/grafana/provisioning/datasources/loki.yaml');
    expect(commandText).not.toContain('/var/lib/grafana/provisioning/datasources/cloudwatch.yaml');
  });
});

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
      mqHostInstanceType: 'mq.t3.micro',
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

  test('the error alert stays quiet when there are no errors', () => {
    const app = new App();
    const muleStack = new MuleRuntimeStack(app, 'MuleRuntimeStack', { ...defaultProps });
    const grafanaStack = new GrafanaStack(app, 'GrafanaStack', {
      ...defaultProps,
      vpc: muleStack.vpc,
      cluster: muleStack.cluster,
    });

    const rule = provisionedFile(
      Template.fromStack(grafanaStack),
      '/var/lib/grafana/provisioning/alerting/mule-runtime-errors.yaml',
    );

    // NoData turned every quiet evaluation into a mailed DatasourceNoData
    // alert, so this must never go back.
    expect(rule).toContain('noDataState: OK');
    expect(rule).not.toContain('noDataState: NoData');
    // Loki holds application logs only; the old runtime-chatter guard is gone.
    expect(rule).not.toContain('applicationName!=""');
  });

  test('the alert mail links to the dashboard for the failing application', () => {
    const app = new App();
    const muleStack = new MuleRuntimeStack(app, 'MuleRuntimeStack', { ...defaultProps });
    const grafanaStack = new GrafanaStack(app, 'GrafanaStack', {
      ...defaultProps,
      vpc: muleStack.vpc,
      cluster: muleStack.cluster,
    });

    const template = Template.fromStack(grafanaStack);
    const rule = provisionedFile(template, '/var/lib/grafana/provisioning/alerting/mule-runtime-errors.yaml');
    const contactPoint = provisionedFile(template, '/var/lib/grafana/provisioning/alerting/sns-contact-point.yaml');

    expect(rule).toContain('var-applicationName={{ $labels.applicationName }}');
    // The mail builds the link from Grafana's own base URL plus the annotation.
    expect(contactPoint).toContain('{{ $grafana }}{{ index .Annotations "dashboard_path" }}');
    expect(rule).toContain('- applicationName');
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

  test('runs an Alloy sidecar that reads only the Mule application log group', () => {
    const app = new App();
    const muleStack = new MuleRuntimeStack(app, 'MuleRuntimeStack', { ...defaultProps });
    const grafanaStack = new GrafanaStack(app, 'GrafanaStack', {
      ...defaultProps,
      vpc: muleStack.vpc,
      cluster: muleStack.cluster,
    });

    const template = Template.fromStack(grafanaStack);

    // Alloy shares the Loki task as a non-essential sidecar.
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: Match.stringLikeRegexp('grafana/alloy'),
          Essential: false,
          Command: Match.arrayWith([Match.stringLikeRegexp('alloy run /tmp/config.alloy')]),
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'MULE_APP_LOG_GROUP', Value: '/mule/development/apps' }),
          ]),
        }),
      ]),
    });

    // The task role may only read the application log group - the per-task
    // runtime groups stay out of Loki - and nothing that AWS bills per call.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:FilterLogEvents', 'logs:GetLogEvents'],
            Resource: [
              'arn:aws:logs:eu-central-1:123456789012:log-group:/mule/development/apps',
              'arn:aws:logs:eu-central-1:123456789012:log-group:/mule/development/apps:*',
            ],
          }),
        ]),
      },
    });
  });
});

/**
 * Grafana's provisioning files are base64 blobs in the container command;
 * decode the one written to `filePath`.
 */
function provisionedFile(template: Template, filePath: string): string {
  const commands = JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'));
  const match = new RegExp(`echo '([A-Za-z0-9+/=]+)' \\| base64 -d > '${filePath}'`).exec(commands);
  if (!match) {
    throw new Error(`No provisioned file found at ${filePath}`);
  }
  return Buffer.from(match[1], 'base64').toString('utf8');
}

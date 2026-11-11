import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Configuration, getConfiguration } from '../src/Configuration';
import { MuleRuntimeStack } from '../src/MuleRuntimeStack';

describe('MuleRuntimeStack taskCount logic', () => {
  const defaultProps = {
    env: { account: '123456789012', region: 'eu-central-1' },
    configuration: {
      taskCount: 0,
      branchName: 'main',
      buildEnvironment: { account: '123456789012', region: 'eu-central-1' },
      targetEnvironment: { account: '123456789012', region: 'eu-central-1' },
      domainName: 'test.com',
      hostedZoneId: 'Z123',
      cpu: 1024,
      memoryLimitMiB: 2048,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      mqHostInstanceType: 'mq.m5.large',
      containerImages: getConfiguration('development').containerImages,
      clientCertificateCommonName: 'data.nijmegen.nl',
    } as unknown as Configuration,
  };

  test('should create exactly 1 ECS Service when taskCount is 0', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackZero', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 0 },
    });

    const template = Template.fromStack(stack);

    // The logic Math.max(1, props.configuration.taskCount) ensures that
    // at least 1 service is created even if taskCount is 0.
    template.resourceCountIs('AWS::ECS::Service', 1);
  });

  test('should create exactly 3 ECS Services when taskCount is 3', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackThree', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 3 },
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::ECS::Service', 3);
  });

  test('shares one application log group across every task', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackAppLogs', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 3 },
    });

    const template = Template.fromStack(stack);

    // Three tasks, three runtime log groups, but only one application group -
    // that is what keeps a correlation ID readable in a single place.
    const logGroups = Object.values(template.findResources('AWS::Logs::LogGroup'))
      .map(group => group.Properties.LogGroupName);
    expect(logGroups.filter(name => name === '/mule/main/apps')).toHaveLength(1);

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/mule/main/apps',
      RetentionInDays: 180,
    });

    // Every task definition points its apps at that one group and stream. The
    // group name is a Ref, so comparing the refs is what proves the three tasks
    // share a group rather than each getting their own.
    const [appLogGroupId] = Object.entries(template.findResources('AWS::Logs::LogGroup'))
      .find(([, group]) => group.Properties.LogGroupName === '/mule/main/apps')!;
    const [appSystemLogGroupId] = Object.entries(template.findResources('AWS::Logs::LogGroup'))
      .find(([, group]) => group.Properties.LogGroupName === '/mule/main/app-system')!;
    const taskDefinitions = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    expect(taskDefinitions).toHaveLength(3);
    taskDefinitions.forEach(taskDefinition => {
      const environment = taskDefinition.Properties.ContainerDefinitions[0].Environment;
      expect(environment).toEqual(expect.arrayContaining([
        { Name: 'MULE_APP_LOG_GROUP', Value: { Ref: appLogGroupId } },
        { Name: 'MULE_APP_LOG_STREAM', Value: 'apps' },
        { Name: 'MULE_APP_SYSTEM_LOG_GROUP', Value: { Ref: appSystemLogGroupId } },
      ]));
    });
  });

  test('mounts one shared EFS access point in every task', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackSharedEfs', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 2 },
    });

    const template = Template.fromStack(stack);

    const [sharedAccessPointId] = Object.entries(template.findResources('AWS::EFS::AccessPoint'))
      .find(([, accessPoint]) => accessPoint.Properties.RootDirectory.Path === '/mule-shared')!;
    const taskDefinitions = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    expect(taskDefinitions).toHaveLength(2);
    taskDefinitions.forEach(taskDefinition => {
      const volume = taskDefinition.Properties.Volumes.find((v: any) =>
        v.EFSVolumeConfiguration.AuthorizationConfig.AccessPointId.Ref === sharedAccessPointId);
      expect(taskDefinition.Properties.ContainerDefinitions[0].MountPoints).toContainEqual(
        expect.objectContaining({ ContainerPath: '/efs-shared', SourceVolume: volume.Name }));
    });
  });

  test('lets the task role write to the application log group', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackAppLogsIam', { ...defaultProps });

    const template = Template.fromStack(stack);

    // The appender runs in the application JVM, so this must be on the task
    // role - the execution role only covers the awslogs driver.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
          }),
        ]),
      },
    });
  });

  test('runs the broker as a single instance in exactly one subnet', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackBroker', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 1 },
    });

    const template = Template.fromStack(stack);

    const broker = Object.values(template.findResources('AWS::AmazonMQ::Broker'))[0];
    expect(broker.Properties.DeploymentMode).toBe('SINGLE_INSTANCE');
    expect(broker.Properties.HostInstanceType).toBe('mq.m5.large');
    expect(broker.Properties.SubnetIds).toHaveLength(1);
    // The name carries a hash of the replacement-forcing properties, so a
    // replacing update never collides with the broker it replaces.
    expect(broker.Properties.BrokerName).toMatch(/^MuleMessageQueue-[0-9a-f]{8}$/);
  });

  test('attaches a broker configuration with per-destination dead-letter queues', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackBrokerConfig', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 1 },
    });

    const template = Template.fromStack(stack);

    const [configLogicalId, configuration] = Object.entries(template.findResources('AWS::AmazonMQ::Configuration'))[0];
    // engineVersion stays unset so autoMinorVersionUpgrade cannot drift away from it.
    expect(configuration.Properties.EngineVersion).toBeUndefined();

    const xml = Buffer.from(configuration.Properties.Data, 'base64').toString('utf8');
    // Matches the <queue>.dlq name the Mule apps already publish to.
    expect(xml).toContain('<individualDeadLetterStrategy queueSuffix=".dlq" useQueueForQueueMessages="true"/>');

    const broker = Object.values(template.findResources('AWS::AmazonMQ::Broker'))[0];
    expect(broker.Properties.Configuration).toEqual({
      Id: { 'Fn::GetAtt': [configLogicalId, 'Id'] },
      Revision: { 'Fn::GetAtt': [configLogicalId, 'Revision'] },
    });
  });

  test('ships general and audit broker logs to CloudWatch', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackBrokerLogs', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 1 },
    });

    const template = Template.fromStack(stack);

    const [policyLogicalId, policy] = Object.entries(template.findResources('AWS::Logs::ResourcePolicy'))[0];
    expect(policy.Properties.PolicyDocument).toContain('mq.amazonaws.com');

    const broker = Object.values(template.findResources('AWS::AmazonMQ::Broker'))[0];
    expect(broker.Properties.Logs).toEqual({ General: true, Audit: true });
    // Without the policy in place first, the broker cannot create its log groups.
    expect(broker.DependsOn).toContain(policyLogicalId);
  });

  test('adds a mule user without console access next to admin', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackBrokerUsers', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 1 },
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::AmazonMQ::Broker', {
      Users: [
        Match.objectLike({ Username: 'admin', ConsoleAccess: true }),
        Match.objectLike({ Username: 'mule', ConsoleAccess: false }),
      ],
    });
  });

  test('writes load balancer access and connection logs', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackLbLogs', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 1 },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'ALB_ACCESS_LOGS' });
    template.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'ALB_CONNECTION_LOGS' });
    template.resourceCountIs('AWS::Logs::Delivery', 2);
  });

  describe('nginx in front of Mule', () => {
    const template = Template.fromStack(new MuleRuntimeStack(new App(), 'MuleRuntimeStackNginx', { ...defaultProps }));
    const containers: any[] = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0].Properties.ContainerDefinitions;
    const nginx = containers.find(container => container.Name === 'NginxContainer');
    const decodeConfig = (command: string) => Buffer.from(command.match(/echo '(.+)' \| base64/)![1], 'base64').toString();
    const allowedPattern = (config: string) => new RegExp(config.match(/"~(.+)" 0;/)![1]);
    const config = decodeConfig(nginx.Command[0]);

    test('is the only load balancer target', () => {
      const service = Object.values(template.findResources('AWS::ECS::Service'))[0];
      expect(service.Properties.LoadBalancers).toEqual([
        expect.objectContaining({ ContainerName: 'NginxContainer', ContainerPort: 8080 }),
      ]);
      const ingressPorts = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'))
        .map(rule => rule.Properties.FromPort);
      expect(ingressPorts).toContain(8080);
      expect(ingressPorts).not.toContain(8081);
    });

    test('fits in the task memory together with Mule', () => {
      expect(containers.reduce((total, container) => total + container.Memory, 0)).toBe(2048);
    });

    test.each([
      ['CN=data.nijmegen.nl,O=Gemeente Nijmegen,C=NL', true],
      ['C=NL,O=Gemeente Nijmegen,CN=data.nijmegen.nl', true],
      ['CN=data.nijmegen.nl', true],
      ['CN=data-test.nijmegen.nl,C=NL', false],
      ['CN=data.nijmegen.nl.evil.com,C=NL', false],
      ['CN=xdata.nijmegen.nl,C=NL', false],
      ['CN=dataxnijmegen.nl,C=NL', false],
      ['CN=evil,O=data.nijmegen.nl', false],
      ['O=evil\\,CN=data.nijmegen.nl,C=NL', false],
      ['O=Foo\\, Inc,CN=data.nijmegen.nl,C=NL', true],
      // A client-sent X_Amzn_Mtls_Clientcert_Subject joined with the ALB's value.
      ['CN=data.nijmegen.nl, CN=evil,C=NL', false],
      ['CN=evil,C=NL, x,CN=data.nijmegen.nl,y', false],
      ['', false],
    ])('allows subject "%s": %s', (subject, allowed) => {
      expect(allowedPattern(config).test(subject)).toBe(allowed);
    });

    test('sets no limit on the request body', () => {
      expect(config).toContain('client_max_body_size 0;');
    });

    test('accepts any CN when none is configured, but still requires a certificate', () => {
      const stack = new MuleRuntimeStack(new App(), 'MuleRuntimeStackNginxAnyCn', {
        ...defaultProps,
        configuration: { ...defaultProps.configuration, clientCertificateCommonName: undefined },
      });
      const definitions: any[] = Object.values(Template.fromStack(stack).findResources('AWS::ECS::TaskDefinition'))[0].Properties.ContainerDefinitions;
      const pattern = allowedPattern(decodeConfig(definitions.find(container => container.Name === 'NginxContainer').Command[0]));
      expect(pattern.test('CN=local-test,O=Dev')).toBe(true);
      expect(pattern.test('')).toBe(false);
    });

    test('checks the domain on acceptance and production only', () => {
      expect(getConfiguration('acceptance').clientCertificateCommonName).toBe('data-test.nijmegen.nl');
      expect(getConfiguration('main').clientCertificateCommonName).toBe('data.nijmegen.nl');
      expect(getConfiguration('development').clientCertificateCommonName).toBeUndefined();
    });
  });
});

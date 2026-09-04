export class Statics {

  /**
   * Name of this project
   * Used in PipelineStack and Statics
   */
  static readonly projectName = 'mule-infra';
  /**
   * Github repository of this project
   * Used in the PipelineStack
   */
  static readonly githubRepository = `GemeenteNijmegen/${Statics.projectName}`;

  static readonly ssmMuleAnypointClientId = `/${Statics.projectName}/mule/anypoint-client-id`;
  static readonly secretMuleAnypointClientSecret = `/${Statics.projectName}/mule/anypoint-client-security`;
  static readonly ssmMuleAnypointOrgId = `/${Statics.projectName}/mule/anypoint-org-id`;
  static readonly ssmMuleAnypointEnvId = `/${Statics.projectName}/mule/anypoint-env-id`;
  static readonly secretMuleLicense = `/${Statics.projectName}/mule/license`;
  static readonly secretMuleKeystorePassword = `/${Statics.projectName}/mule/keystorepassword`;
  static readonly secretMuleTruststorePassword = `/${Statics.projectName}/mule/truststorepassword`;
  static readonly secretMuleCredentials = `/${Statics.projectName}/mule/credentials`;
  static readonly muleCredentialNames: string[] = [
    // Add Mule application credential names here, e.g.:
    // 'notifynl-nijm-sapi',
    'hello-world',
    'notify-nl',
    'corsa',
  ];

  // MARK: environments
  static readonly buildEnvironment = {
    account: '836443378780',
    region: 'eu-central-1',
  };

  static readonly productionEnvironment = {
    account: '664926621746',
    region: 'eu-central-1',
  };

  static readonly acceptanceEnvironment = {
    account: '938595516784',
    region: 'eu-central-1',
  };

  static readonly developmentEnvironment = {
    account: '013052902779',
    region: 'eu-central-1',
  };

  // MARK: account hostedzone
  static readonly accountHostedzonePath = '/gemeente-nijmegen/account/hostedzone';
  static readonly accountHostedzoneName = '/gemeente-nijmegen/account/hostedzone/name';
  static readonly accountHostedzoneId = '/gemeente-nijmegen/account/hostedzone/id';
  static readonly ssmALBtruststore = `/${Statics.projectName}/alb/truststore`;
  static readonly secretMuleTrustStore = `/${Statics.projectName}/mule/truststore`;
  static readonly secretMuleKeyStore = `/${Statics.projectName}/mule/keystore`;
  static readonly muleDockerImageRepositoryArn = 'arn:aws:ecr:eu-central-1:836443378780:repository/mule-docker-image';
  static readonly muleDockerImageHash = '80a493a7156142b369b7ab364387fed6744dcfe6';
  static readonly grafanaDockerImage = 'grafana/grafana:13.1.3';
  static readonly lokiDockerImage = 'grafana/loki:3.5.3';

  // MARK: proxy task (on-demand tinyproxy)
  static readonly proxyContainerPort = 8888;
  static readonly ssmProxyClusterName = `/${Statics.projectName}/proxy/cluster-name`;
  static readonly ssmProxyTaskDefinitionArn = `/${Statics.projectName}/proxy/task-definition-arn`;
  static readonly ssmProxySubnetId = `/${Statics.projectName}/proxy/subnet-id`;
  static readonly ssmProxySecurityGroupId = `/${Statics.projectName}/proxy/security-group-id`;

  // MARK: ActiveMQ web console (reachable via scripts/mq-console.sh)
  static readonly activeMqConsolePort = 8162;
  static readonly ssmActiveMqConsoleUrls = `/${Statics.projectName}/activemq/console-urls`;
  static readonly ssmActiveMqAdminSecretArn = `/${Statics.projectName}/activemq/admin-secret-arn`;

}
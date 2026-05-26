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

}
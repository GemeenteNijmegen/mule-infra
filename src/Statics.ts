export class Statics {

  /**
   * Name of this project
   * Used in PipelineStack and Statics
   */
  static readonly projectName = 'mule-infra';
  /**
   * Github repository of this project
   * Used in the PipelineStack
   * TODO make sure this is correct
   */
  static readonly githubRepository = `GemeenteNijmegen/${Statics.projectName}`;

  static readonly ssmDummyParameter = `/${Statics.projectName}/dummy/parameter`;

  static readonly ssmMuleServerName = `/${Statics.projectName}/mule/server-name`;
  static readonly ssmMuleAnypointEnvToken = `/${Statics.projectName}/mule/anypoint-env-token`;
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

}
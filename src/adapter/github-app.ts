import { WebhookEvent } from '@octokit/webhooks'
import cacheManager from 'cache-manager'
import jwt from 'jsonwebtoken'
import { Adapter } from '.'
import { Context } from '../context'
import { GitHubAPI } from '../github'
import { logger } from '../logger'
import { LoggerWithTarget, wrapLogger } from '../wrap-logger'

// Some events can't get an authenticated client (#382):
function isUnauthenticatedEvent (event: WebhookEvent) {
  return !event.payload.installation ||
    (event.name === 'installation' && event.payload.action === 'deleted')
}

export class GitHubApp implements Adapter {
  public log: LoggerWithTarget
  public id: number
  public cert: string

  private cache: any

  /**
   * @param id - ID of the GitHub App
   * @param cert - The private key of the GitHub App
   */
  constructor (id: number, cert: string) {
    this.id = id
    this.cert = cert
    this.log = wrapLogger(logger, logger)
    this.cache = cacheManager.caching({
      store: 'memory',
      ttl: 60 * 60 // 1 hour
    })
  }

  /**
   * Create a new JWT, which is used to [authenticate as a GitHub
   * App](https://developer.github.com/apps/building-github-apps/authenticating-with-github-apps/#authenticating-as-a-github-app)
   */
  public jwt () {
    const payload = {
      exp: Math.floor(Date.now() / 1000) + 60,  // JWT expiration time
      iat: Math.floor(Date.now() / 1000),       // Issued at time
      iss: this.id                              // GitHub App ID
    }

    // Sign with RSA SHA256
    return jwt.sign(payload, this.cert, { algorithm: 'RS256' })
  }

  public async createContext (event: WebhookEvent) {
    const log = this.log.child({ name: 'event', id: event.id })

    let github

    if (isUnauthenticatedEvent(event)) {
      github = await this.auth()
      log.debug('`context.github` is unauthenticated. See https://probot.github.io/docs/github-api/#unauthenticated-events')
    } else {
      github = await this.auth(event.payload.installation!.id, log)
    }

    return new Context(event, github, log)
  }

  /**
   * Authenticate and get a GitHub client that can be used to make API calls.
   *
   * You'll probably want to use `context.github` instead.
   *
   * **Note**: `app.auth` is asynchronous, so it needs to be prefixed with a
   * [`await`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await)
   * to wait for the magic to happen.
   *
   * ```js
   *  module.exports = (app) => {
   *    app.on('issues.opened', async context => {
   *      const github = await app.auth();
   *    });
   *  };
   * ```
   *
   * @param id - ID of the installation, which can be extracted from
   * `context.payload.installation.id`. If called without this parameter, the
   * client wil authenticate [as the app](https://developer.github.com/apps/building-integrations/setting-up-and-registering-github-apps/about-authentication-options-for-github-apps/#authenticating-as-a-github-app)
   * instead of as a specific installation, which means it can only be used for
   * [app APIs](https://developer.github.com/v3/apps/).
   *
   * @returns An authenticated GitHub API client
   * @private
   */
  public async auth (id?: number, log = this.log): Promise<GitHubAPI> {
    if (process.env.GHE_HOST && /^https?:\/\//.test(process.env.GHE_HOST)) {
      throw new Error('Your \`GHE_HOST\` environment variable should not begin with https:// or http://')
    }

    const github = GitHubAPI({
      baseUrl: process.env.GHE_HOST && `https://${process.env.GHE_HOST}/api/v3`,
      debug: process.env.LOG_LEVEL === 'trace',
      logger: log.child({ name: 'github', installation: String(id) })
    })

    // Cache for 1 minute less than GitHub expiry
    const installationTokenTTL = parseInt(process.env.INSTALLATION_TOKEN_TTL || '3540', 10)

    if (id) {
      const res = await this.cache.wrap(`app:${id}:token`, () => {
        log.trace(`creating token for installation`)
        github.authenticate({ type: 'app', token: this.jwt() })

        return github.apps.createInstallationToken({ installation_id: id })
      }, { ttl: installationTokenTTL })

      github.authenticate({ type: 'token', token: res.data.token })
    } else {
      github.authenticate({ type: 'app', token: this.jwt() })
    }

    return github
  }
}

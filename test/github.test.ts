const {GitHub} = require('../src/github')
const nock = require('nock')
const Bottleneck = require('bottleneck')

describe('GitHub', () => {
  let github

  beforeEach(() => {
    const logger = {
      debug: jest.fn(),
      trace: jest.fn()
    }

    // Set a shorter limiter, otherwise tests are _slow_
    const limiter = new Bottleneck(1, 1)

    github = GitHub({ logger, limiter })
  })

  test('works without options', async () => {
    github = GitHub()
    const user = {login: 'ohai'}

    nock('https://api.github.com').get('/user').reply(200, user)
    expect((await github.users.get({})).data).toEqual(user)
  })

  describe('paginate', () => {
    beforeEach(() => {
      // Prepare an array of issue objects
      const issues = new Array(5).fill(null).map((_, i, arr) => {
        return {
          title: `Issue number ${i}`,
          id: i,
          number: i
        }
      })

      nock('https://api.github.com')
        .get('/repos/JasonEtco/pizza/issues?per_page=1').reply(200, issues[0], {
          link: '<https://api.github.com/repositories/123/issues?per_page=1&page=2>; rel="next"'
        })
        .get('/repositories/123/issues?per_page=1&page=2').reply(200, issues[1], {
          link: '<https://api.github.com/repositories/123/issues?per_page=1&page=3>; rel="next"'
        })
        .get('/repositories/123/issues?per_page=1&page=3').reply(200, issues[2], {
          link: '<https://api.github.com/repositories/123/issues?per_page=1&page=4>; rel="next"'
        })
        .get('/repositories/123/issues?per_page=1&page=4').reply(200, issues[3], {
          link: '<https://api.github.com/repositories/123/issues?per_page=1&page=5>; rel="next"'
        })
        .get('/repositories/123/issues?per_page=1&page=5').reply(200, issues[4], {
          link: ''
        })
    })

    it('returns an array of pages', async () => {
      const spy = jest.fn()
      const res = await github.paginate(github.issues.getForRepo({ owner: 'JasonEtco', repo: 'pizza', per_page: 1 }), spy)
      expect(Array.isArray(res)).toBeTruthy()
      expect(res.length).toBe(5)
      expect(spy).toHaveBeenCalledTimes(5)
    })

    it('stops iterating if the done() function is called in the callback', async () => {
      const spy = jest.fn((res, done) => {
        if (res.data.id === 2) {
          done()
        }
      })
      const data = await github.paginate(github.issues.getForRepo({ owner: 'JasonEtco', repo: 'pizza', per_page: 1 }), spy)
      expect(data.length).toBe(3)
      expect(spy).toHaveBeenCalledTimes(3)
    })
  })
})

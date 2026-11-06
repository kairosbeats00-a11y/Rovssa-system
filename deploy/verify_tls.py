"""Check CA trust, hostname, expiry and unauthenticated rejection. No bypass flags."""
import argparse
import ssl
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def verify(url, cafile=None):
    parsed=urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username:
        raise ValueError('An HTTPS URL without embedded credentials is required')
    context=ssl.create_default_context(cafile=cafile)
    context.minimum_version=ssl.TLSVersion.TLSv1_2
    # Do not follow a redirect to another host or to HTTP.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=context),NoRedirect())
    try:
        with opener.open(url, timeout=5) as response:
            raise RuntimeError(f'Expected authentication challenge, received HTTP {response.status}')
    except urllib.error.HTTPError as exc:
        if exc.code != 401 or not exc.headers.get('WWW-Authenticate','').startswith('Basic '):
            raise RuntimeError(f'Expected Basic authentication challenge, received HTTP {exc.code}') from exc
    return True


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('--ca',help='Trusted CA PEM, obtained through a trusted channel')
    args=parser.parse_args()
    verify(args.url,args.ca)
    print('Verified TLS certificate chain, hostname and expiry; unauthenticated request rejected.')

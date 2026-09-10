# Builds IHateMoney from the pinned upstream commit + ihm-categoryid.patch
# (see README.md) instead of vendoring a full fork copy.
#
# Stage 1: fetch upstream source and apply the patch.
FROM python:3.11-alpine AS patched-source

RUN apk add --no-cache git

# "Back to development: 7.2.2" — the commit the patch was created against.
# Bump this when rebasing.
ARG IHATEMONEY_REF=e66a7672e8e5c41549bf53c4a824c72c43ab9079

RUN git clone https://github.com/spiral-project/ihatemoney.git /src \
	&& cd /src \
	&& git checkout ${IHATEMONEY_REF}

COPY ihm-categoryid.patch /tmp/ihm-categoryid.patch
RUN cd /src && git apply --verbose /tmp/ihm-categoryid.patch

# Stage 2: identical to the official ihatemoney/Dockerfile, with ADD replaced
# by COPY --from=patched-source.
FROM python:3.11-alpine

ENV PORT="8000" \
	PYTHONDONTWRITEBYTECODE=1 \
	PYTHONUNBUFFERED=1

ENV DEBUG="False" \
	ACTIVATE_ADMIN_DASHBOARD="False" \
	ACTIVATE_DEMO_PROJECT="True" \
	ADMIN_PASSWORD="" \
	ALLOW_PUBLIC_PROJECT_CREATION="True" \
	BABEL_DEFAULT_TIMEZONE="UTC" \
	GREENLET_TEST_CPP="no" \
	MAIL_DEFAULT_SENDER="Budget manager <admin@example.com>" \
	MAIL_PASSWORD="" \
	MAIL_PORT="25" \
	MAIL_SERVER="localhost" \
	MAIL_USE_SSL="False" \
	MAIL_USE_TLS="False" \
	MAIL_USERNAME="" \
	SECRET_KEY="tralala" \
	SESSION_COOKIE_SECURE="True" \
	SHOW_ADMIN_EMAIL="True" \
	SQLALCHEMY_DATABASE_URI="sqlite:////database/ihatemoney.db" \
	SQLALCHEMY_TRACK_MODIFICATIONS="False" \
	APPLICATION_ROOT="/" \
	ENABLE_CAPTCHA="False" \
	LEGAL_LINK=""

COPY --from=patched-source /src /src

RUN echo "**** install build dependencies ****" &&\
	apk add --no-cache --virtual=build-dependencies \
	gcc \
	musl-dev \
	postgresql-dev &&\
	echo "**** install runtime packages ****" && \
	apk add --no-cache \
	shadow \
	postgresql-libs && \
	echo "**** create runtime folder ****" && \
	mkdir -p /etc/ihatemoney &&\
	echo "**** install pip packages ****" && \
	pip install --no-cache-dir \
	gunicorn && \
	pip install --no-cache-dir -e /src[database] && \
	echo "**** create user abc:abc ****" && \
	useradd -u 1000 -U -d /src abc && \
	echo "**** cleanup ****" && \
	apk del --purge build-dependencies &&\
	rm -rf \
	/tmp/*

VOLUME /database
EXPOSE ${PORT}
ENTRYPOINT ["/src/conf/entrypoint.sh"]

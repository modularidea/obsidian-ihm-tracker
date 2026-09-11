# Builds the IHM Tracker server fork (modularidea/ihatemoney-cat) straight
# from GitHub — for users without a local checkout. The plugin's own
# docker-compose.yml builds from the sibling checkout ../../ihatemoney-cat
# instead (see there).
#
# Stage 1: fetch the fork branch.
FROM python:3.11-alpine AS fork-source

RUN apk add --no-cache git

ARG IHATEMONEY_FORK_REPO=https://github.com/modularidea/ihatemoney-cat.git
ARG IHATEMONEY_FORK_BRANCH=feat/categoryid

RUN git clone --depth 1 --branch ${IHATEMONEY_FORK_BRANCH} ${IHATEMONEY_FORK_REPO} /src

# Stage 2: identical to the official ihatemoney/Dockerfile, with ADD replaced
# by COPY --from=fork-source.
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

COPY --from=fork-source /src /src

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

FROM nginx:1.27-alpine

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY nginx.conf /etc/nginx/nginx.conf
COPY proxy-common.conf /etc/nginx/proxy-common.conf
COPY index.html app.js styles.css /usr/share/nginx/html/

# nginx.conf listens on 8080 (unprivileged) specifically so the whole
# process, not just the workers, can run as a non-root user.
RUN chown -R appuser:appgroup /usr/share/nginx/html /var/cache/nginx /etc/nginx

EXPOSE 8080
USER appuser

# Use 127.0.0.1, not localhost: Alpine's /etc/hosts resolves "localhost" to
# ::1 (IPv6) only, but nginx's `listen 8080;` binds IPv4-only. wget would
# then try ::1:8080, get connection refused, and mark a perfectly healthy
# container unhealthy forever.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]

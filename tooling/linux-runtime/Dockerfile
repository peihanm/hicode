FROM scratch AS build
ARG TARGETARCH
ADD rootfs/${TARGETARCH}.tar.gz /
RUN apk add --no-cache build-base linux-headers meson ninja pkgconf file xz
WORKDIR /build
COPY sources/ ./sources/
RUN tar -xf sources/libcap-2.76.tar.xz && \
    make -C libcap-2.76/libcap -j2 BUILD_CC=gcc CC=gcc GOLANG=no PAM_CAP=no libcap.a && \
    mkdir -p /usr/local/include/sys /usr/local/lib/pkgconfig && \
    cp libcap-2.76/libcap/include/sys/capability.h /usr/local/include/sys/ && \
    cp libcap-2.76/libcap/libcap.a /usr/local/lib/ && \
    printf 'prefix=/usr/local\nlibdir=${prefix}/lib\nincludedir=${prefix}/include\nName: libcap\nDescription: Linux capabilities\nVersion: 2.76\nLibs: -L${libdir} -lcap\nCflags: -I${includedir}\n' > /usr/local/lib/pkgconfig/libcap.pc
RUN tar -xf sources/bubblewrap-0.13.0.tar.xz && \
    meson setup bwrap-build bubblewrap-0.13.0 -Dselinux=disabled -Dman=disabled -Dtests=false \
      -Dbash_completion=disabled -Dzsh_completion=disabled -Dc_link_args=-static --buildtype=minsize && \
    ninja -C bwrap-build -j2
RUN tar -xf sources/socat-1.8.1.3.tar.gz && cd socat-1.8.1.3 && \
    patch -p1 < ../sources/use-linux-headers.patch && patch -p1 < ../sources/netdb-internal.patch && \
    CFLAGS=-Os LDFLAGS=-static ./configure --disable-openssl --disable-readline --disable-libwrap && make -j2
RUN mkdir -p /out/bin /out/licenses && \
    cp bwrap-build/bwrap socat-1.8.1.3/socat /out/bin/ && strip /out/bin/* && \
    file /out/bin/* | tee /out/build-info.txt && \
    ! readelf -l /out/bin/bwrap | grep INTERP && ! readelf -l /out/bin/socat | grep INTERP && \
    /out/bin/bwrap --version && /out/bin/socat -V && \
    cp bubblewrap-0.13.0/COPYING /out/licenses/bubblewrap.txt && \
    cp socat-1.8.1.3/COPYING /out/licenses/socat.txt && \
    cp libcap-2.76/License /out/licenses/libcap.txt && \
    tar -xf sources/musl-1.2.5.tar.gz && cp musl-1.2.5/COPYRIGHT /out/licenses/musl.txt
FROM scratch
COPY --from=build /out/ /

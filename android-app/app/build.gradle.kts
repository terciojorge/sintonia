plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.example.my_fire_iptv"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.example.my_fire_iptv"
        minSdk = 24
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            optimization {
                enable = true
                packageScope = setOf("androidx.**", "kotlin.**", "kotlinx.**")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.core.ktx)
    implementation(libs.material)
    // WorkManager: atualização da interface web em segundo plano (OTA)
    implementation(libs.androidx.work.runtime)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
    // Dependências do Media3 (ExoPlayer) para vídeo e HLS (M3U8)
    implementation("androidx.media3:media3-exoplayer:1.2.1")
    implementation("androidx.media3:media3-ui:1.2.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.2.1")
    // Dependência do NanoHTTPD para o servidor local (QR Code)
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}